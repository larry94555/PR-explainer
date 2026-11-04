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

  it('keeps the place in the PR', () => {
    expect(
      explainJob({ context: 'c', cause: 'ahead', job: { label: 'x', order: 4 } }),
    ).toMatchObject({ order: 4 });
  });
});
