import {
  createPrefetchQueue,
  explainJob,
  MAX_ATTEMPTS,
  priorityFor,
  type JobPriority,
  type JobSpec,
  type QueueDeps,
  type QueueEvent,
} from '../src/explain/prefetchQueue';
import { createSavedQueue, SAVED_QUEUE_KEY, showsPr } from '../src/explain/savedQueue';

interface Result {
  status: 'done' | 'failed';
  text: string;
  cached?: boolean;
}

/** A fake model: every run waits until the test finishes it. */
function fakeModel() {
  const runs: {
    payload: string;
    signal: AbortSignal;
    ended: boolean;
    chunk(text: string): void;
    finish(result?: Partial<Result>): void;
    throw(error: Error): void;
  }[] = [];
  const run: QueueDeps<string, Result>['run'] = (payload, { signal, onChunk }) =>
    new Promise<Result>((resolve, reject) => {
      const entry: (typeof runs)[number] = {
        payload,
        signal,
        ended: false,
        chunk: onChunk,
        finish: (result = {}) => {
          entry.ended = true;
          resolve({ status: 'done', text: `answer to ${payload}`, ...result });
        },
        throw: (error) => {
          entry.ended = true;
          reject(error);
        },
      };
      runs.push(entry);
    });
  /** The runs neither stopped nor ended yet. */
  const live = () => runs.filter((r) => !r.signal.aborted && !r.ended);
  return { run, runs, live };
}

function setup(overrides: Partial<QueueDeps<string, Result>> = {}) {
  const model = fakeModel();
  const events: QueueEvent[] = [];
  let time = 0;
  const queue = createPrefetchQueue<string, Result>({
    run: model.run,
    failed: (r) => r.status === 'failed',
    cached: (r) => r.cached === true,
    now: () => time,
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  const job = (
    id: string,
    priority: JobPriority = 'on-screen',
    extra: Partial<JobSpec<string>> = {},
  ): JobSpec<string> => ({ id, label: id, priority, payload: id, ...extra });
  // A dropped job rejects; tests that do not wait for it should not fail on that.
  const add: typeof queue.add = (spec, options) => {
    const answer = queue.add(spec, options);
    answer.catch(() => {});
    return answer;
  };
  return {
    queue: { ...queue, add },
    ...model,
    events,
    job,
    types: () => events.map((e) => `${e.type} ${e.label}`),
    setTime: (ms: number) => (time = ms),
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe('the background queue', () => {
  it('runs one job at a time by default, highest priority first (a hover stops a lower job)', async () => {
    const env = setup();
    void env.queue.add(env.job('rest-1', 'rest'));
    void env.queue.add(env.job('screen-1', 'on-screen'));
    void env.queue.add(env.job('near-1', 'near-screen'));
    void env.queue.add(env.job('hover-1', 'hovered'));
    expect(env.live().map((r) => r.payload)).toEqual(['hover-1']);
    expect(env.queue.state()).toEqual({
      running: ['hover-1'],
      waiting: ['screen-1', 'near-1', 'rest-1'],
    });
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const run = env.live()[0]!;
      order.push(run.payload);
      run.finish();
      await settle();
    }
    expect(order).toEqual(['hover-1', 'screen-1', 'near-1', 'rest-1']);
  });

  it('runs lines of the same priority in the order they appear in the PR', async () => {
    const env = setup();
    void env.queue.add(env.job('busy', 'on-screen'));
    void env.queue.add(env.job('line-30', 'rest', { order: 30 }));
    void env.queue.add(env.job('line-10', 'rest', { order: 10 }));
    void env.queue.add(env.job('line-20', 'rest', { order: 20 }));
    expect(env.queue.state().waiting).toEqual(['line-10', 'line-20', 'line-30']);
  });

  it('runs at most `concurrency` jobs at once', async () => {
    const env = setup({ concurrency: 2 });
    for (const id of ['a', 'b', 'c', 'd']) void env.queue.add(env.job(id));
    expect(env.live().map((r) => r.payload)).toEqual(['a', 'b']);
    env.live()[0]!.finish();
    await settle();
    expect(env.live().map((r) => r.payload)).toEqual(['b', 'c']);
  });

  it('reads a `concurrency` function each time a job could start (Requests at once, PR 10.6)', async () => {
    let atOnce = 1;
    const env = setup({ concurrency: () => atOnce });
    for (const id of ['a', 'b', 'c', 'd']) void env.queue.add(env.job(id));
    expect(env.live().map((r) => r.payload)).toEqual(['a']);
    atOnce = 3;
    env.live()[0]!.finish();
    await settle();
    expect(env.live().map((r) => r.payload)).toEqual(['b', 'c', 'd']);
  });

  it('runs one at a time when `concurrency` gives something that is not a count', () => {
    const env = setup({ concurrency: () => NaN });
    for (const id of ['a', 'b']) void env.queue.add(env.job(id));
    expect(env.live()).toHaveLength(1);
  });

  it('resolves each job with its answer', async () => {
    const env = setup();
    const answer = env.queue.add(env.job('a'));
    env.runs[0]!.finish();
    await expect(answer).resolves.toEqual({ status: 'done', text: 'answer to a' });
    expect(env.types()).toEqual(['queued a', 'started a', 'finished a']);
  });

  it('logs a job answered from the cache as skipped', async () => {
    const env = setup();
    const answer = env.queue.add(env.job('a'));
    env.runs[0]!.finish({ cached: true });
    await expect(answer).resolves.toMatchObject({ cached: true });
    expect(env.types()).toContain('skipped a');
  });

  it('merges a second job for the same request, keeping the higher priority', async () => {
    const env = setup();
    // A click keeps the hovered job waiting.
    void env.queue.add(env.job('busy', 'click'));
    const first = env.queue.add(env.job('a', 'rest'));
    const second = env.queue.add(env.job('a', 'hovered'));
    void env.queue.add(env.job('b', 'on-screen'));
    // a is now a hovered job, ahead of b; still one job.
    expect(env.queue.state().waiting).toEqual(['a', 'b']);
    env.live()[0]!.finish();
    await settle();
    env.live()[0]!.finish();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toBe(two);
    expect(env.runs.filter((r) => r.payload === 'a')).toHaveLength(1);
    expect(env.types()).toContain('joined a');
  });

  it('never lowers a job when a lower priority asks for it', () => {
    const env = setup();
    // A click keeps the hovered job waiting.
    void env.queue.add(env.job('busy', 'click'));
    void env.queue.add(env.job('a', 'hovered'));
    void env.queue.add(env.job('a', 'rest'));
    void env.queue.add(env.job('b', 'on-screen'));
    expect(env.queue.state().waiting).toEqual(['a', 'b']);
  });
});

describe('paused while Ollama is down (PR 11.6)', () => {
  it('stops starting background work while down, and resumes once Ollama is back', async () => {
    const env = setup();
    const a = env.queue.add(env.job('a'));
    void env.queue.add(env.job('b'));
    void env.queue.add(env.job('c', 'rest'));
    // The first job fails because Ollama went away; the worker pauses.
    env.queue.setPaused(true, 'ollama');
    env.live()[0]!.finish({ status: 'failed' });
    await settle();
    // Nothing else starts, so nothing else fails line by line.
    expect(env.live()).toEqual([]);
    expect(env.queue.state()).toEqual({ running: [], waiting: ['b', 'a', 'c'] });
    expect(env.types()).not.toContain('failed a');

    env.queue.setPaused(false, 'ollama');
    expect(env.live().map((r) => r.payload)).toEqual(['b']);
    env.live()[0]!.finish();
    await settle();
    // The failed one is tried again, and now answered.
    env.live()[0]!.finish();
    await expect(a).resolves.toMatchObject({ text: 'answer to a' });
  });

  it('still runs a click while down, so its popup shows the full error', async () => {
    const env = setup();
    env.queue.setPaused(true, 'ollama');
    void env.queue.add(env.job('a'));
    const click = env.queue.add(env.job('x', 'click'));
    expect(env.live().map((r) => r.payload)).toEqual(['x']);
    env.live()[0]!.finish({ status: 'failed' });
    await expect(click).resolves.toMatchObject({ status: 'failed' });
    await settle();
    expect(env.live()).toEqual([]);
  });

  it('keeps the battery and Ollama pauses apart: both must end before work resumes', () => {
    const env = setup();
    env.queue.setPaused(true, 'ollama');
    env.queue.setPaused(true);
    void env.queue.add(env.job('a'));
    // Plugging in does not resume work while Ollama is still down.
    env.queue.setPaused(false);
    expect(env.live()).toEqual([]);
    env.queue.setPaused(false, 'ollama');
    expect(env.live().map((r) => r.payload)).toEqual(['a']);
  });
});

describe('paused on battery (PR 11.3)', () => {
  it('starts no background job while paused, and starts them once resumed', async () => {
    const env = setup();
    env.queue.setPaused(true);
    void env.queue.add(env.job('a'));
    void env.queue.add(env.job('h', 'hovered'));
    expect(env.live()).toEqual([]);
    expect(env.queue.state()).toEqual({ running: [], waiting: ['h', 'a'] });

    env.queue.setPaused(false);
    expect(env.live().map((r) => r.payload)).toEqual(['h']);
    env.live()[0]!.finish();
    await settle();
    expect(env.live().map((r) => r.payload)).toEqual(['a']);
  });

  it('lets a running background job finish, then starts nothing new', async () => {
    const env = setup();
    const a = env.queue.add(env.job('a'));
    void env.queue.add(env.job('b'));
    env.queue.setPaused(true);
    expect(env.runs[0]!.signal.aborted).toBe(false);
    env.live()[0]!.finish();
    await expect(a).resolves.toMatchObject({ text: 'answer to a' });
    await settle();
    expect(env.live()).toEqual([]);
    expect(env.queue.state().waiting).toEqual(['b']);
  });

  it('still runs a click at once', async () => {
    const env = setup();
    env.queue.setPaused(true);
    void env.queue.add(env.job('a'));
    const click = env.queue.add(env.job('x', 'click'));
    expect(env.live().map((r) => r.payload)).toEqual(['x']);
    env.live()[0]!.finish();
    await expect(click).resolves.toMatchObject({ text: 'answer to x' });
    await settle();
    // The background still waits.
    expect(env.live()).toEqual([]);
  });

  it('runs a click that joins a waiting background job', () => {
    const env = setup();
    env.queue.setPaused(true);
    void env.queue.add(env.job('a'));
    void env.queue.add(env.job('a', 'click'));
    expect(env.live().map((r) => r.payload)).toEqual(['a']);
  });

  it('is not paused by default (Keep going never calls setPaused)', () => {
    const env = setup();
    void env.queue.add(env.job('a'));
    expect(env.live().map((r) => r.payload)).toEqual(['a']);
  });
});

describe('a click', () => {
  it('runs at once, stopping the running background job and putting it back first', async () => {
    const env = setup();
    void env.queue.add(env.job('a'));
    void env.queue.add(env.job('b'));
    env.setTime(1200);
    const click = env.queue.add(env.job('x', 'click'));
    expect(env.runs[0]!.signal.aborted).toBe(true);
    expect(env.live().map((r) => r.payload)).toEqual(['x']);
    expect(env.events).toContainEqual(
      expect.objectContaining({ type: 'cancelled', label: 'a', elapsedMs: 1200 }),
    );
    // a goes back in front of b.
    expect(env.queue.state()).toEqual({ running: ['x'], waiting: ['a', 'b'] });

    env.live()[0]!.finish();
    await expect(click).resolves.toMatchObject({ text: 'answer to x' });
    await settle();
    expect(env.live().map((r) => r.payload)).toEqual(['a']);
  });

  it("ignores the stopped run's late answer, and gives the job the next run's", async () => {
    const env = setup();
    const background = env.queue.add(env.job('a'));
    void env.queue.add(env.job('x', 'click'));
    // The handler answers a stopped request with a failure.
    env.runs[0]!.finish({ status: 'failed', text: 'aborted' });
    env.runs[1]!.finish();
    await settle();
    env.live()[0]!.finish();
    await expect(background).resolves.toEqual({ status: 'done', text: 'answer to a' });
  });

  it('keeps background jobs waiting until the click is answered', async () => {
    const env = setup({ concurrency: 1 });
    void env.queue.add(env.job('x', 'click'));
    void env.queue.add(env.job('a'));
    expect(env.live().map((r) => r.payload)).toEqual(['x']);
    env.live()[0]!.finish();
    await settle();
    expect(env.live().map((r) => r.payload)).toEqual(['a']);
  });

  it('runs alongside another click (a click never waits)', () => {
    const env = setup();
    void env.queue.add(env.job('x', 'click'));
    void env.queue.add(env.job('y', 'click'));
    expect(env.live().map((r) => r.payload)).toEqual(['x', 'y']);
  });

  it('joins a running job for the same line: one request, the text so far, then the rest', async () => {
    const env = setup();
    const background = env.queue.add(env.job('a', 'on-screen'));
    env.runs[0]!.chunk('**What it does** Ad');
    const got: string[] = [];
    const click = env.queue.add(env.job('a', 'click'), { onChunk: (t) => got.push(t) });
    expect(env.runs).toHaveLength(1);
    expect(env.runs[0]!.signal.aborted).toBe(false);
    expect(got).toEqual(['**What it does** Ad']);
    env.runs[0]!.chunk('ds one.');
    expect(got).toEqual(['**What it does** Ad', 'ds one.']);
    env.runs[0]!.finish();
    const [one, two] = await Promise.all([background, click]);
    expect(one).toBe(two);
  });

  it('starts a waiting job for the same line at once', () => {
    const env = setup();
    void env.queue.add(env.job('b'));
    void env.queue.add(env.job('a'));
    void env.queue.add(env.job('a', 'click'));
    expect(env.live().map((r) => r.payload)).toEqual(['a']);
    expect(env.queue.state().waiting).toEqual(['b']);
  });

  it('makes a joined job a click, so a later click on other code does not stop it', () => {
    const env = setup();
    void env.queue.add(env.job('a'));
    void env.queue.add(env.job('a', 'click'));
    void env.queue.add(env.job('x', 'click'));
    expect(env.live().map((r) => r.payload)).toEqual(['a', 'x']);
  });

  it('sends chunks only to clicks (background callers only want the answer cached)', () => {
    const env = setup();
    const chunks: string[] = [];
    void env.queue.add(env.job('a'), { onChunk: (t) => chunks.push(t) });
    env.runs[0]!.chunk('text');
    expect(chunks).toEqual([]);
  });
});

describe('a hovered line', () => {
  it('stops a lower running job when there is no room, and puts it back first', () => {
    const env = setup();
    void env.queue.add(env.job('a', 'on-screen'));
    void env.queue.add(env.job('b', 'on-screen'));
    void env.queue.add(env.job('h', 'hovered'));
    expect(env.runs[0]!.signal.aborted).toBe(true);
    expect(env.queue.state()).toEqual({ running: ['h'], waiting: ['a', 'b'] });
  });

  it('does not stop a click', () => {
    const env = setup();
    void env.queue.add(env.job('x', 'click'));
    void env.queue.add(env.job('h', 'hovered'));
    expect(env.queue.state()).toEqual({ running: ['x'], waiting: ['h'] });
  });

  it('is the only priority that stops lower ones (scrolling never throws work away)', () => {
    const env = setup();
    void env.queue.add(env.job('r', 'rest'));
    void env.queue.add(env.job('s', 'on-screen'));
    expect(env.queue.state()).toEqual({ running: ['r'], waiting: ['s'] });
  });
});

describe('failures', () => {
  it('tries a failed background job once more, after the others of its priority, then gives up', async () => {
    const env = setup();
    const a = env.queue.add(env.job('a'));
    void env.queue.add(env.job('b'));
    env.runs[0]!.finish({ status: 'failed' });
    await settle();
    expect(env.queue.state()).toEqual({ running: ['b'], waiting: ['a'] });
    env.live()[0]!.finish();
    await settle();
    expect(env.live().map((r) => r.payload)).toEqual(['a']);
    env.live()[0]!.finish({ status: 'failed' });
    await expect(a).resolves.toMatchObject({ status: 'failed' });
    expect(env.runs.filter((r) => r.payload === 'a')).toHaveLength(MAX_ATTEMPTS);
    expect(env.types()).toEqual(expect.arrayContaining(['retry a', 'failed a']));
  });

  it('treats a run that throws as a failure, and rejects once it has given up', async () => {
    const env = setup();
    const a = env.queue.add(env.job('a'));
    env.runs[0]!.throw(new Error('boom'));
    await settle();
    env.runs[1]!.throw(new Error('boom again'));
    await expect(a).rejects.toThrow('boom again');
  });

  it('never tries a click again by itself (the popup shows the failure)', async () => {
    const env = setup();
    const click = env.queue.add(env.job('x', 'click'));
    env.runs[0]!.finish({ status: 'failed' });
    await expect(click).resolves.toMatchObject({ status: 'failed' });
    expect(env.runs).toHaveLength(1);
  });

  it('keeps going when run throws straight away', async () => {
    const env = setup({
      run: () => {
        throw new Error('bad payload');
      },
    });
    await expect(env.queue.add(env.job('x', 'click'))).rejects.toThrow('bad payload');
  });
});

describe('callers going away, re-prioritising and dropping', () => {
  it('drops a job whose only caller has gone, stopping it, and runs the next', async () => {
    const env = setup();
    const gone = new AbortController();
    const a = env.queue.add(env.job('a'), { signal: gone.signal });
    void env.queue.add(env.job('b'));
    gone.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.runs[0]!.signal.aborted).toBe(true);
    expect(env.live().map((r) => r.payload)).toEqual(['b']);
    expect(env.types()).toContain('dropped a');
  });

  it('keeps a job running while another caller still waits for it', async () => {
    const env = setup();
    const hover = new AbortController();
    void env.queue.add(env.job('a', 'hovered'), { signal: hover.signal });
    const click = env.queue.add(env.job('a', 'click'));
    hover.abort();
    expect(env.runs[0]!.signal.aborted).toBe(false);
    env.runs[0]!.finish();
    await expect(click).resolves.toMatchObject({ status: 'done' });
  });

  it('rejects at once when the caller has already gone', async () => {
    const env = setup();
    const gone = new AbortController();
    gone.abort();
    await expect(env.queue.add(env.job('a'), { signal: gone.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(env.runs).toHaveLength(0);
  });

  it('re-prioritises waiting background jobs (after a scroll)', () => {
    const env = setup();
    void env.queue.add(env.job('busy'));
    void env.queue.add(env.job('a', 'on-screen', { pr: 'o/r#1' }));
    void env.queue.add(env.job('b', 'rest', { pr: 'o/r#1' }));
    expect(env.queue.prioritise((job) => job.id === 'b', 'on-screen')).toBe(1);
    expect(env.queue.prioritise((job) => job.id === 'a', 'near-screen')).toBe(1);
    expect(env.queue.state().waiting).toEqual(['b', 'a']);
  });

  it('drops the jobs of a tab or a PR', async () => {
    const env = setup();
    const a = env.queue.add(env.job('a', 'on-screen', { tab: 1, pr: 'o/r#1' }));
    void env.queue.add(env.job('b', 'on-screen', { tab: 1, pr: 'o/r#1' }));
    void env.queue.add(env.job('c', 'on-screen', { tab: 2, pr: 'o/r#2' }));
    expect(env.queue.drop((job) => job.tab === 1)).toBe(2);
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.queue.state()).toEqual({ running: ['c'], waiting: [] });
    expect(env.queue.drop((job) => job.pr === 'o/r#2')).toBe(1);
    expect(env.queue.state()).toEqual({ running: [], waiting: [] });
  });
});

describe('a click joining a running job (review on #62)', () => {
  it('stops the other running background jobs, keeps the joined one going, and resumes them after', async () => {
    const env = setup({ concurrency: 2 });
    void env.queue.add(env.job('a'));
    void env.queue.add(env.job('b'));
    env.runs[0]!.chunk('Ad');
    const got: string[] = [];
    const click = env.queue.add(env.job('a', 'click'), { onChunk: (t) => got.push(t) });
    // b is stopped and put back; a keeps its run and what it has written.
    expect(env.runs[1]!.signal.aborted).toBe(true);
    expect(env.runs[0]!.signal.aborted).toBe(false);
    expect(env.queue.state()).toEqual({ running: ['a'], waiting: ['b'] });
    expect(got).toEqual(['Ad']);
    env.runs[0]!.chunk('ds one.');
    env.runs[0]!.finish();
    await expect(click).resolves.toMatchObject({ text: 'answer to a' });
    await settle();
    expect(env.live().map((r) => r.payload)).toEqual(['b']);
    expect(env.runs.filter((r) => r.payload === 'a')).toHaveLength(1);
  });
});

describe('a new click with room for two', () => {
  it('stops both background jobs, and they wait until it is answered', async () => {
    const env = setup({ concurrency: 2 });
    void env.queue.add(env.job('a'));
    void env.queue.add(env.job('b'));
    void env.queue.add(env.job('x', 'click'));
    expect(env.queue.state()).toEqual({ running: ['x'], waiting: ['b', 'a'] });
    env.live()[0]!.finish();
    await settle();
    expect(env.live().map((r) => r.payload)).toEqual(['b', 'a']);
  });
});

describe('closing a tab (review on #62)', () => {
  it("lets go of that tab's callers only: a job another tab joined keeps running for it", async () => {
    const env = setup();
    void env.queue.add(env.job('same', 'on-screen', { tab: 1 }));
    const got: string[] = [];
    const click = env.queue.add(env.job('same', 'click', { tab: 2 }), {
      onChunk: (t) => got.push(t),
    });
    expect(env.queue.dropTab(1)).toBe(0);
    expect(env.runs[0]!.signal.aborted).toBe(false);
    env.runs[0]!.chunk('still coming');
    expect(got).toEqual(['still coming']);
    env.runs[0]!.finish();
    await expect(click).resolves.toMatchObject({ text: 'answer to same' });
    expect(env.runs).toHaveLength(1);
  });

  it('drops the jobs only that tab waits for, and runs the next', async () => {
    const env = setup();
    const a = env.queue.add(env.job('a', 'on-screen', { tab: 1 }));
    void env.queue.add(env.job('b', 'on-screen', { tab: 1 }));
    void env.queue.add(env.job('c', 'on-screen', { tab: 2 }));
    expect(env.queue.dropTab(1)).toBe(2);
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.runs[0]!.signal.aborted).toBe(true);
    expect(env.queue.state()).toEqual({ running: ['c'], waiting: [] });
  });
});

describe('two tabs', () => {
  it('share one queue: one job running across both', async () => {
    const env = setup();
    void env.queue.add(env.job('tab1-a', 'on-screen', { tab: 1 }));
    void env.queue.add(env.job('tab2-a', 'on-screen', { tab: 2 }));
    void env.queue.add(env.job('tab1-b', 'on-screen', { tab: 1 }));
    expect(env.live()).toHaveLength(1);
    env.live()[0]!.finish();
    await settle();
    expect(env.live().map((r) => r.payload)).toEqual(['tab2-a']);
  });

  it('share an answer: the same line asked by both is one request', async () => {
    const env = setup();
    const one = env.queue.add(env.job('same', 'on-screen', { tab: 1 }));
    const two = env.queue.add(env.job('same', 'click', { tab: 2 }));
    expect(env.runs).toHaveLength(1);
    env.runs[0]!.finish();
    expect(await one).toBe(await two);
  });
});

describe('the events', () => {
  it('say how many jobs are running and waiting after each one', () => {
    const env = setup();
    void env.queue.add(env.job('a', 'on-screen', { tab: 3 }));
    void env.queue.add(env.job('b'));
    expect(env.events).toEqual([
      { type: 'queued', label: 'a', priority: 'on-screen', tab: 3, running: 0, waiting: 1 },
      { type: 'started', label: 'a', priority: 'on-screen', tab: 3, running: 1, waiting: 0 },
      { type: 'queued', label: 'b', priority: 'on-screen', running: 1, waiting: 1 },
    ]);
  });
});

describe('explain requests as jobs', () => {
  it('gives each cause its priority', () => {
    expect(priorityFor('click')).toBe('click');
    expect(priorityFor(undefined)).toBe('click');
    expect(priorityFor('hover')).toBe('hovered');
    expect(priorityFor('ahead')).toBe('on-screen');
  });

  it('names a job by its PR and code, so the same line from a click and a hover is one job', () => {
    const hover = explainJob(
      { context: 'code', pr: 'o/r#1', cause: 'hover', job: { label: 'src/a.ts:added:3' } },
      7,
    );
    const click = explainJob({ context: 'code', pr: 'o/r#1' }, 7);
    expect(hover.id).toBe(click.id);
    expect(hover).toMatchObject({
      label: 'src/a.ts:added:3',
      priority: 'hovered',
      tab: 7,
      pr: 'o/r#1',
    });
    expect(click).toMatchObject({ label: 'clicked code', priority: 'click' });
    expect(explainJob({ context: 'code', pr: 'o/r#2' }).id).not.toBe(click.id);
    expect(explainJob({ context: 'other', pr: 'o/r#1' }).id).not.toBe(click.id);
  });

  it('gives Regenerate a job of its own, so it never joins', () => {
    const a = explainJob({ context: 'code', pr: 'o/r#1', fresh: true });
    const b = explainJob({ context: 'code', pr: 'o/r#1', fresh: true });
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(explainJob({ context: 'code', pr: 'o/r#1' }).id);
  });

  it('takes the priority Whole PR gives a background request (PR 10.6), but never a higher one', () => {
    const ahead = (priority: unknown) =>
      explainJob({
        context: 'c',
        cause: 'ahead',
        job: { label: 'x', priority: priority as 'rest' },
      }).priority;
    expect(ahead('near-screen')).toBe('near-screen');
    expect(ahead('rest')).toBe('rest');
    expect(ahead('on-screen')).toBe('on-screen');
    expect(ahead('click')).toBe('on-screen');
    expect(ahead('hovered')).toBe('on-screen');
    // A click and a hover keep theirs.
    expect(explainJob({ context: 'c', job: { label: 'x', priority: 'rest' } }).priority).toBe(
      'click',
    );
    expect(
      explainJob({ context: 'c', cause: 'hover', job: { label: 'x', priority: 'rest' } }).priority,
    ).toBe('hovered');
    // A hunk too.
    expect(
      explainJob({
        context: 'section',
        cause: 'ahead',
        job: { label: 'x', priority: 'near-screen' },
        hunk: { text: 'section', lines: [{ label: 'l', context: 'one', line: 1, code: '+a' }] },
      }).priority,
    ).toBe('near-screen');
  });

  it('keeps the place in the PR', () => {
    expect(
      explainJob({ context: 'c', cause: 'ahead', job: { label: 'x', order: 4 } }),
    ).toMatchObject({ order: 4 });
  });
});

describe('hunk jobs (PR 10.5)', () => {
  const hunk = (
    env: ReturnType<typeof setup>,
    lines: string[],
    extra: Partial<JobSpec<string>> = {},
  ) => env.job(`hunk:${lines.join(',')}`, 'on-screen', { covers: lines, ...extra });

  it('makes a click on a line of the running hunk job wait for it instead of sending its own request', async () => {
    const env = setup();
    void env.queue.add(hunk(env, ['a', 'b']));
    const click = env.queue.add(env.job('a', 'click'));
    await settle();
    expect(env.live().map((r) => r.payload)).toEqual(['hunk:a,b']);
    expect(env.queue.state()).toEqual({ running: ['hunk:a,b'], waiting: ['a'] });
    env.live()[0]!.finish();
    await settle();
    // Now it runs, and the handler answers it from the cache the hunk filled.
    expect(env.live().map((r) => r.payload)).toEqual(['a']);
    env.live()[0]!.finish({ cached: true });
    await expect(click).resolves.toMatchObject({ cached: true });
    expect(env.runs.map((r) => r.payload)).toEqual(['hunk:a,b', 'a']);
  });

  it('still stops the other background jobs for that click, and keeps them waiting until it is answered', async () => {
    const env = setup({ concurrency: 2 });
    void env.queue.add(hunk(env, ['a', 'b']));
    void env.queue.add(env.job('other'));
    expect(env.live()).toHaveLength(2);
    void env.queue.add(env.job('b', 'click'));
    expect(env.live().map((r) => r.payload)).toEqual(['hunk:a,b']);
    expect(env.types()).toContain('cancelled other');
    env.live()[0]!.finish();
    await settle();
    // The click goes first; the other job waits for it.
    expect(env.live().map((r) => r.payload)).toEqual(['b']);
    env.live()[0]!.finish({ cached: true });
    await settle();
    expect(env.live().map((r) => r.payload)).toEqual(['other']);
  });

  it('runs the click at once when the hunk job is only waiting', () => {
    const env = setup();
    void env.queue.add(env.job('busy'));
    void env.queue.add(hunk(env, ['a', 'b']));
    void env.queue.add(env.job('a', 'click'));
    expect(env.live().map((r) => r.payload)).toEqual(['a']);
  });

  it('makes a hover on a line of the running hunk job wait too, instead of stopping it', () => {
    const env = setup();
    void env.queue.add(hunk(env, ['a', 'b']));
    void env.queue.add(env.job('a', 'hovered'));
    expect(env.live().map((r) => r.payload)).toEqual(['hunk:a,b']);
    expect(env.types()).not.toContain('cancelled hunk:a,b');
  });

  it('queues the lines its answer left out as single-line jobs, first in its priority', async () => {
    const env = setup({
      followUps: (spec) =>
        spec.covers ? [env.job('b', 'rest', { tab: 3 }), env.job('c', 'rest', { tab: 3 })] : [],
    });
    void env.queue.add(hunk(env, ['a', 'b', 'c'], { tab: 3 }));
    void env.queue.add(env.job('later'));
    env.live()[0]!.finish();
    await settle();
    expect(env.queue.state()).toEqual({ running: ['b'], waiting: ['c', 'later'] });
    expect(env.events.find((e) => e.type === 'queued' && e.label === 'c')?.priority).toBe(
      'on-screen',
    );
    // Nobody waits for them, but closing the tab lets go of them.
    expect(env.queue.dropTab(3)).toBe(2);
    expect(env.queue.state()).toEqual({ running: ['later'], waiting: [] });
  });

  it('does not queue a line again that already has a job, nor follow up a failed hunk', async () => {
    const followUps = vi.fn(() => [
      { id: 'b', label: 'b', priority: 'rest' as const, payload: 'b' },
    ]);
    const env = setup({ followUps });
    void env.queue.add(hunk(env, ['a', 'b']));
    const click = env.queue.add(env.job('b', 'click'));
    env.live()[0]!.finish();
    await settle();
    expect(env.queue.state()).toEqual({ running: ['b'], waiting: [] });
    env.live()[0]!.finish();
    await click;
    // A failed hunk job is tried again, then given up on, with no follow-ups.
    followUps.mockClear();
    void env.queue.add(hunk(env, ['x']));
    env.live()[0]!.finish({ status: 'failed' });
    await settle();
    env.live()[0]!.finish({ status: 'failed' });
    await settle();
    expect(followUps).not.toHaveBeenCalled();
  });

  it('turns a hunk request into a background job covering the job of each of its lines', () => {
    const line = (context: string) => ({ label: context, context, line: 1, code: '+x' });
    const spec = explainJob(
      {
        context: 'section',
        pr: 'o/r#1',
        cause: 'ahead',
        job: { label: 'src/a.ts: lines 1, 2' },
        hunk: { text: 'section', lines: [line('one'), line('two')] },
      },
      7,
    );
    expect(spec).toMatchObject({ priority: 'on-screen', label: 'src/a.ts: lines 1, 2', tab: 7 });
    expect(spec.covers).toEqual([
      explainJob({ context: 'one', pr: 'o/r#1' }).id,
      explainJob({ context: 'two', pr: 'o/r#1' }).id,
    ]);
    expect(spec.id).not.toBe(explainJob({ context: 'section', pr: 'o/r#1' }).id);
    // Never a click, even if one says so.
    expect(explainJob({ context: 's', hunk: { text: 's', lines: [line('one')] } }).priority).toBe(
      'on-screen',
    );
  });
});

/** An in-memory chrome.storage.session; it outlives each worker made on it, like the real one. */
function fakeSession() {
  const data: Record<string, unknown> = {};
  const writes: unknown[] = [];
  return {
    data,
    writes,
    get: async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
    set: async (items: Record<string, unknown>) => {
      // Stored as a copy, like Chrome does.
      Object.assign(data, structuredClone(items));
      writes.push(structuredClone(items[SAVED_QUEUE_KEY]));
    },
  };
}

const PR_URL = 'https://github.com/o/r/pull/1/files';

/**
 * One run of the service worker on `session`: a queue, its saver, and the
 * restart started as background.ts starts it. A new call is the worker
 * Chrome starts again; the old one's queue is simply forgotten.
 */
function worker(
  session: ReturnType<typeof fakeSession>,
  openTabs: (number | { id: number; url?: string })[] = [1, 2],
  overrides: Partial<QueueDeps<string, Result>> = {},
) {
  const tabs = openTabs.map((tab) => (typeof tab === 'number' ? { id: tab, url: PR_URL } : tab));
  const saver = createSavedQueue<string>({ storage: session, openTabs: async () => tabs });
  const env = setup({ onChange: () => saver.changed(), ...overrides });
  const restart = saver.start(env.queue);
  return { ...env, saver, restart };
}

describe('the background queue across a worker restart (PR 11.5)', () => {
  const ids = (session: ReturnType<typeof fakeSession>) =>
    (session.data[SAVED_QUEUE_KEY] as { spec: { id: string } }[]).map((job) => job.spec.id);

  it('saves its background jobs on each change, running first, without answers', async () => {
    const session = fakeSession();
    const w = worker(session);
    expect(await w.restart).toEqual({ restarted: false, restored: 0 });
    void w.queue.add(w.job('a', 'on-screen', { tab: 1, pr: 'o/r#1', order: 3 }));
    void w.queue.add(w.job('b', 'rest', { tab: 2 }));
    void w.queue.add(w.job('c', 'near-screen', { tab: 1 }));
    await w.saver.flushed();
    expect(session.data[SAVED_QUEUE_KEY]).toEqual([
      {
        spec: {
          id: 'a',
          label: 'a',
          priority: 'on-screen',
          payload: 'a',
          tab: 1,
          pr: 'o/r#1',
          order: 3,
        },
        tabs: [1],
        running: true,
      },
      { spec: expect.objectContaining({ id: 'c' }), tabs: [1] },
      { spec: expect.objectContaining({ id: 'b' }), tabs: [2] },
    ]);
    w.live()[0]!.finish();
    await settle();
    await w.saver.flushed();
    // Finished: gone, and the next one is saved as running.
    expect(ids(session)).toEqual(['c', 'b']);
    expect((session.data[SAVED_QUEUE_KEY] as { running?: boolean }[])[0]!.running).toBe(true);
    // A burst of changes is one write.
    const before = session.writes.length;
    w.queue.drop(() => true);
    await w.saver.flushed();
    expect(session.writes.length).toBe(before + 1);
    expect(session.data[SAVED_QUEUE_KEY]).toEqual([]);
  });

  it('leaves out clicks, hovers and Regenerate, whose page stops waiting when the worker does', async () => {
    const session = fakeSession();
    const w = worker(session);
    await w.restart;
    void w.queue.add(w.job('click', 'click', { tab: 1 }));
    void w.queue.add(w.job('hover', 'hovered', { tab: 1 }));
    void w.queue.add(w.job('line', 'rest', { tab: 1 }));
    await w.saver.flushed();
    expect(ids(session)).toEqual(['line']);
  });

  it('restores the jobs after a restart in the same order, the running job first', async () => {
    const session = fakeSession();
    const first = worker(session);
    await first.restart;
    for (const id of ['near', 'screen-1', 'screen-2']) {
      void first.queue.add(first.job(id, id === 'near' ? 'near-screen' : 'on-screen', { tab: 1 }));
    }
    // "near" started first, then the on-screen ones queued behind it.
    expect(first.queue.state()).toEqual({ running: ['near'], waiting: ['screen-1', 'screen-2'] });
    void first.queue.add(first.job('rest-1', 'rest', { tab: 2 }));
    await first.saver.flushed();

    // Chrome stops the worker: a new one starts on the same session storage.
    const second = worker(session);
    expect(await second.restart).toEqual({ restarted: true, restored: 4 });
    // Priority still comes first; the job that was running goes first in its own.
    expect(second.queue.state()).toEqual({
      running: ['screen-1'],
      waiting: ['screen-2', 'near', 'rest-1'],
    });
    expect(second.events.at(-2)).toMatchObject({
      type: 'restored',
      label: '4 jobs restored',
      running: 0,
      waiting: 4,
    });
    // A new line of the same priority waits behind the restored ones.
    void second.queue.add(second.job('screen-3', 'on-screen', { tab: 1 }));
    expect(second.queue.state().waiting.slice(0, 2)).toEqual(['screen-2', 'screen-3']);
  });

  it('puts a running job back first among jobs of its priority', async () => {
    const session = fakeSession();
    const first = worker(session);
    await first.restart;
    void first.queue.add(first.job('x', 'rest', { tab: 1, order: 50 }));
    void first.queue.add(first.job('y', 'rest', { tab: 1, order: 1 }));
    void first.queue.add(first.job('z', 'rest', { tab: 1, order: 2 }));
    expect(first.queue.state()).toEqual({ running: ['x'], waiting: ['y', 'z'] });
    await first.saver.flushed();
    const second = worker(session);
    await second.restart;
    expect(second.queue.state()).toEqual({ running: ['x'], waiting: ['y', 'z'] });
  });

  it('drops the jobs of tabs that have closed, keeping a job another open tab waits for', async () => {
    const session = fakeSession();
    const first = worker(session, [1, 2]);
    await first.restart;
    void first.queue.add(first.job('busy', 'on-screen', { tab: 1 }));
    void first.queue.add(first.job('only-1', 'rest', { tab: 1 }));
    void first.queue.add(first.job('shared', 'rest', { tab: 1 }));
    void first.queue.add(first.job('shared', 'rest', { tab: 2 }));
    void first.queue.add(first.job('only-2', 'rest', { tab: 2 }));
    await first.saver.flushed();
    // Tab 1 closed while the worker was stopped.
    const second = worker(session, [2]);
    expect(await second.restart).toEqual({ restarted: true, restored: 2 });
    expect(second.queue.state()).toEqual({ running: ['shared'], waiting: ['only-2'] });
    // Closing tab 2 too lets go of them.
    expect(second.queue.dropTab(2)).toBe(2);
    expect(second.queue.state()).toEqual({ running: [], waiting: [] });
  });

  it('finishes a restored job whose answer is now cached at once, logged as skipped', async () => {
    const session = fakeSession();
    const first = worker(session);
    await first.restart;
    void first.queue.add(first.job('a', 'on-screen', { tab: 1 }));
    await first.saver.flushed();
    // The handler answers from the cache without the model.
    const second = worker(session, [1], {
      run: async () => ({ status: 'done', text: 'x', cached: true }),
    });
    await second.restart;
    await settle();
    expect(second.types()).toEqual(['restored 1 job restored', 'started a', 'skipped a']);
    await second.saver.flushed();
    expect(session.data[SAVED_QUEUE_KEY]).toEqual([]);
  });

  it('does nothing twice: a page asking again joins the restored job', async () => {
    const session = fakeSession();
    const first = worker(session);
    await first.restart;
    void first.queue.add(first.job('a', 'on-screen', { tab: 1 }));
    await first.saver.flushed();
    const second = worker(session);
    await second.restart;
    // Explain ahead sends the same line again once it hears of the restart.
    const answer = second.queue.add(second.job('a', 'on-screen', { tab: 1 }));
    expect(second.runs).toHaveLength(1);
    second.live()[0]!.finish();
    await expect(answer).resolves.toMatchObject({ text: 'answer to a' });
    expect(second.runs).toHaveLength(1);
  });

  it('keeps a job a page queued before the restore finished, and does not overwrite what was saved', async () => {
    const session = fakeSession();
    const first = worker(session);
    await first.restart;
    void first.queue.add(first.job('a', 'rest', { tab: 1 }));
    void first.queue.add(first.job('b', 'rest', { tab: 1 }));
    await first.saver.flushed();
    const writes = session.writes.length;
    const second = worker(session);
    // Before the saved jobs are read back.
    void second.queue.add(second.job('b', 'rest', { tab: 1, label: 'b again' }));
    await Promise.resolve();
    expect(session.writes.length).toBe(writes);
    expect(await second.restart).toEqual({ restarted: true, restored: 1 });
    expect(second.runs.map((r) => r.payload)).toEqual(['b']);
    expect(second.queue.state().waiting).toEqual(['a']);
    await second.saver.flushed();
    expect(ids(session).sort()).toEqual(['a', 'b']);
  });

  it('ignores saved jobs it cannot read and a storage that fails', async () => {
    const session = fakeSession();
    session.data[SAVED_QUEUE_KEY] = [
      null,
      { spec: { id: 1 }, tabs: [1] },
      { spec: { id: 'x', label: 'x', priority: 'nope', payload: {} }, tabs: [1] },
      { spec: { id: 'ok', label: 'ok', priority: 'rest', payload: { context: 'c' } }, tabs: [1] },
    ];
    const w = worker(session, [1]);
    expect(await w.restart).toEqual({ restarted: true, restored: 1 });
    expect(w.queue.state().running).toEqual(['ok']);

    const broken = createSavedQueue<string>({
      storage: {
        get: async () => {
          throw new Error('gone');
        },
        set: async () => {
          throw new Error('gone');
        },
      },
      openTabs: async () => [],
    });
    const env = setup({ onChange: () => broken.changed() });
    expect(await broken.start(env.queue)).toEqual({ restarted: false, restored: 0 });
    void env.queue.add(env.job('a', 'rest', { tab: 1 }));
    await expect(broken.flushed()).resolves.toBeUndefined();
  });

  it('drops restored jobs whose tab is still open but no longer shows their PR (review on #74)', async () => {
    const session = fakeSession();
    const first = worker(session);
    await first.restart;
    void first.queue.add(first.job('busy', 'on-screen', { tab: 9, pr: 'o/r#1' }));
    void first.queue.add(first.job('pr-1', 'rest', { tab: 1, pr: 'o/r#1' }));
    void first.queue.add(first.job('other-site', 'rest', { tab: 2, pr: 'o/r#1' }));
    void first.queue.add(first.job('other-pr', 'rest', { tab: 3, pr: 'o/r#1' }));
    await first.saver.flushed();
    const second = worker(session, [
      { id: 1, url: 'https://github.com/O/R/pull/1' },
      // Not on GitHub: Chrome gives no url without host permission.
      { id: 2 },
      { id: 3, url: 'https://github.com/o/r/pull/2/files' },
    ]);
    expect(await second.restart).toEqual({ restarted: true, restored: 1 });
    expect(second.queue.state()).toEqual({ running: ['pr-1'], waiting: [] });
  });

  it('lets go of restored work when its open tab leaves the PR, keeping work another tab shares (review on #74)', async () => {
    const session = fakeSession();
    const first = worker(session);
    await first.restart;
    void first.queue.add(first.job('only-1', 'on-screen', { tab: 1, pr: 'o/r#1' }));
    void first.queue.add(first.job('also-1', 'rest', { tab: 1, pr: 'o/r#1' }));
    void first.queue.add(first.job('shared', 'rest', { tab: 1, pr: 'o/r#1' }));
    void first.queue.add(first.job('shared', 'rest', { tab: 2, pr: 'o/r#1' }));
    await first.saver.flushed();
    const second = worker(session);
    await second.restart;
    expect(second.queue.state()).toEqual({ running: ['only-1'], waiting: ['also-1', 'shared'] });
    const running = second.live()[0]!;
    // A move within the same PR keeps it.
    expect(second.queue.releaseTab(1, 'o/r#1')).toBe(0);
    // Tab 1 moves to another PR (or loads another page) without closing.
    expect(second.queue.releaseTab(1, 'o/r#2')).toBe(2);
    expect(running.signal.aborted).toBe(true);
    expect(second.queue.state()).toEqual({ running: ['shared'], waiting: [] });
    await second.saver.flushed();
    expect(ids(session)).toEqual(['shared']);
    // Tab 2 loads another page too: nothing is left, saved or running.
    expect(second.queue.releaseTab(2)).toBe(1);
    await second.saver.flushed();
    expect(session.data[SAVED_QUEUE_KEY]).toEqual([]);
    expect(second.live()).toEqual([]);
  });

  it("does not let go of a page's own request when its tab moves, only held work", async () => {
    const env = setup();
    const answer = env.queue.add(env.job('asked', 'on-screen', { tab: 1, pr: 'o/r#1' }));
    expect(env.queue.releaseTab(1)).toBe(0);
    env.live()[0]!.finish();
    await expect(answer).resolves.toMatchObject({ text: 'answer to asked' });
  });

  it('tells which tab urls show a PR', () => {
    expect(showsPr('https://github.com/o/r/pull/1', 'o/r#1')).toBe(true);
    expect(showsPr('https://github.com/O/R/pull/1/files?w=1#diff-1', 'o/r#1')).toBe(true);
    expect(showsPr('https://github.com/o/r/pull/12', 'o/r#1')).toBe(false);
    expect(showsPr('https://github.com/o/r/issues/1', 'o/r#1')).toBe(false);
    expect(showsPr('https://example.com/o/r/pull/1', 'o/r#1')).toBe(false);
    expect(showsPr(undefined, 'o/r#1')).toBe(false);
    expect(showsPr('not a url', 'o/r#1')).toBe(false);
    expect(showsPr(undefined, undefined)).toBe(true);
  });
});
