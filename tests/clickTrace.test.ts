import { createClickTrace, traceLine } from '../src/trace/clickTrace';
import type { WorkerTrace } from '../src/trace/types';

/** A clock the test moves by hand, starting at 1000 ms. */
function fakeClock() {
  let time = 1000;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createClickTrace', () => {
  it('records tasks in order with their start and duration, from the click', () => {
    const clock = fakeClock();
    const trace = createClickTrace(clock.now);
    clock.advance(2);
    const find = trace.start('find-code', 'Find the code');
    clock.advance(3);
    find();
    find(); // Ending twice records once.
    clock.advance(10);
    const send = trace.start('send', 'Send the request');
    clock.advance(1);
    send();
    expect(trace.now()).toBe(16);
    expect(trace.tasks()).toEqual([
      { key: 'find-code', label: 'Find the code', source: 'page', startMs: 2, durationMs: 3 },
      { key: 'send', label: 'Send the request', source: 'page', startMs: 15, durationMs: 1 },
    ]);
  });

  it('keeps the own times of tasks that overlap, such as the two GitHub fetches', async () => {
    const clock = fakeClock();
    const trace = createClickTrace(clock.now);
    let readDescription!: () => void;
    let readFile!: () => void;
    trace.time(
      'pr-description',
      'Read the PR description',
      new Promise<void>((r) => (readDescription = r)),
    );
    trace.time('file-at-head', 'Fetch the file at head', new Promise<void>((r) => (readFile = r)));
    clock.advance(120);
    readDescription();
    await flush();
    clock.advance(300);
    readFile();
    await flush();
    expect(trace.tasks().map((t) => [t.key, t.startMs, t.durationMs])).toEqual([
      ['pr-description', 0, 120],
      ['file-at-head', 0, 420],
    ]);
  });

  it('marks a task that failed or was skipped', async () => {
    const clock = fakeClock();
    const trace = createClickTrace(clock.now);
    const failing = Promise.reject(new Error('GitHub answered 404'));
    await expect(trace.time('file-at-head', 'Fetch the file at head', failing)).rejects.toThrow();
    trace.skip('pr-description', 'Read the PR description');
    const stopped = trace.start('send', 'Send the request');
    stopped('failed');
    expect(trace.tasks().map((t) => [t.key, t.status])).toEqual([
      ['file-at-head', 'failed'],
      ['pr-description', 'skipped'],
      ['send', 'failed'],
    ]);
  });

  it("lines the service worker's tasks up with the moment the request was sent", () => {
    const clock = fakeClock();
    const trace = createClickTrace(clock.now);
    clock.advance(300);
    trace.markSent();
    clock.advance(9_000);
    const worker: WorkerTrace = {
      totalMs: 8_950,
      tasks: [
        { key: 'settings', label: 'Read settings', source: 'worker', startMs: 0, durationMs: 4 },
        {
          key: 'model',
          label: 'Wait for the model',
          source: 'worker',
          startMs: 50,
          durationMs: 8_800,
          firstChunkMs: 3_000,
        },
      ],
    };
    trace.addWorker(worker);
    clock.advance(40);
    trace.finish();
    expect(trace.tasks()).toEqual([
      { key: 'settings', label: 'Read settings', source: 'worker', startMs: 300, durationMs: 4 },
      {
        key: 'model',
        label: 'Wait for the model',
        source: 'worker',
        startMs: 350,
        durationMs: 8_800,
        firstChunkMs: 3_000,
      },
      // From the worker's last task (300 + 8,950) to the popup showing it.
      { key: 'show', label: 'Show answer', source: 'page', startMs: 9_250, durationMs: 90 },
    ]);
  });

  it('lines them up to end now when the click joined a prefetch, cutting what came before the click', () => {
    const clock = fakeClock();
    const trace = createClickTrace(clock.now);
    clock.advance(1_000);
    // The prefetch started 3 s before the click and finishes 1 s after it.
    trace.addWorker({
      totalMs: 4_000,
      tasks: [
        { key: 'settings', label: 'Read settings', source: 'worker', startMs: 0, durationMs: 5 },
        {
          key: 'model',
          label: 'Wait for the model',
          source: 'worker',
          startMs: 10,
          durationMs: 3_990,
          firstChunkMs: 3_500,
        },
      ],
    });
    expect(trace.tasks()).toEqual([
      {
        key: 'model',
        label: 'Wait for the model',
        source: 'worker',
        startMs: 0,
        durationMs: 1_000,
        firstChunkMs: 510,
      },
    ]);
  });

  it('adds nothing when the result carries no trace', () => {
    const trace = createClickTrace(fakeClock().now);
    trace.addWorker(undefined);
    expect(trace.tasks()).toEqual([]);
  });
});

describe('traceLine', () => {
  it('lists the tasks for the console, with ~ for estimates and the status when not done', () => {
    expect(
      traceLine([
        { label: 'Find the code', durationMs: 2.4 },
        { label: 'Fetch the file at head', durationMs: 0, status: 'skipped' },
        { label: 'Read the PR description', durationMs: 30, status: 'failed' },
        { label: 'Think', durationMs: 20_100, estimated: true },
        { label: 'Show answer', durationMs: 1_250 },
      ]),
    ).toBe(
      'Find the code 2 ms, Fetch the file at head skipped, ' +
        'Read the PR description failed after 30 ms, Think ~20.1 s, Show answer 1.3 s',
    );
  });
});
