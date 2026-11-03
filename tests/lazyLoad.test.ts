// Lazy-loaded diffs (PR 7.2): on a large PR, GitHub adds file diffs to the
// page as you scroll, and big files wait for a "Load diff" click. Click-to-
// explain and selection listen on the document, so diffs added after they
// were attached work without being found or wired up one by one.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClickHandler, type ClickHandlerDeps } from '../src/clickHandler';
import type { ExplainResult } from '../src/explain/explainHandler';
import { DiffPageFeatures } from '../src/navigation';
import type { Popup } from '../src/popup/popup';
import { installSelection, SELECTION_UI_ID } from '../src/selection';

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
}

const FILES_URL = 'https://github.com/larry94555/PR-explainer/pull/28/files';
const ANCHOR = 'diff-6a17656d764b8e1930354f341cf7f47960b63845c3046edcd8bbf282aaa2f464';

const DONE: ExplainResult = {
  status: 'done',
  explanation: { what: 'What.', why: 'Why.', concerns: 'None found.' },
  model: 'qwen2.5-coder:7b',
};

/** Attaches click-to-explain and selection the way src/content.ts does. */
function attach() {
  const contexts: string[] = [];
  const deps: ClickHandlerDeps = {
    explain: vi.fn((context: string) => {
      contexts.push(context);
      return { result: Promise.resolve(DONE), stop: vi.fn() };
    }),
    openPopup: (_anchor, hooks) =>
      ({
        host: document.createElement('div'),
        state: 'loading',
        elapsedMs: 0,
        showLoading: () => {},
        showPartial: () => {},
        showExplanation: () => {},
        showError: () => {},
        showPrompt: () => {},
        showTrace: () => {},
        close: () => hooks.onClose(),
      }) as Popup,
  };
  const onClick = createClickHandler(deps);
  const features = new DiffPageFeatures(() => {
    document.addEventListener('click', onClick);
    const removeSelection = installSelection(deps);
    return () => {
      document.removeEventListener('click', onClick);
      removeSelection();
    };
  });
  features.sync(FILES_URL);
  return { deps, contexts, detach: () => features.sync('https://github.com/') };
}

/** Adds a file's diff to the page later, the way GitHub's lazy loading does. */
function loadLater(html: string, into: Element = document.body): void {
  const template = document.createElement('template');
  template.innerHTML = html;
  into.append(template.content);
}

function click(target: Element, init: MouseEventInit = {}): void {
  for (const type of ['mousedown', 'mouseup', 'click']) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...init }));
  }
}

const added44 = () =>
  document.querySelector(`[id="${ANCHOR}R44"]`)!.closest('tr')!.querySelector('.blob-code-inner')!;

let env: ReturnType<typeof attach>;
beforeEach(() => {
  // A Files changed page whose diffs have not loaded yet.
  document.body.innerHTML =
    '<div class="js-diff-progressive-container"><include-fragment class="diff-placeholder">' +
    '<button type="button" class="load-diff-button">Load diff</button></include-fragment></div>';
  env = attach();
});
afterEach(() => {
  env.detach();
  document.body.innerHTML = '';
});

describe('diffs that load after click-to-explain is attached', () => {
  it('explains a line in a file added later', () => {
    loadLater(fixture('github-diff-classic.html'));
    click(added44());
    expect(env.deps.explain).toHaveBeenCalledTimes(1);
    expect(env.contexts[0]).toContain('File: docs/roadmap.md');
    expect(env.contexts[0]).toContain('Clicked line: added, line 44 of the new file');
  });

  it('explains a line in a diff that replaced a "Load diff" placeholder', () => {
    const placeholder = document.querySelector('include-fragment')!;
    // The button itself is GitHub's, so clicking it explains nothing.
    click(placeholder.querySelector('button')!);
    expect(env.deps.explain).not.toHaveBeenCalled();

    const template = document.createElement('template');
    template.innerHTML = fixture('github-diff-new-split.html');
    placeholder.replaceWith(template.content);
    const removed = document.querySelector('td[data-line-anchor$="L62"]')!;
    click(removed);
    expect(env.deps.explain).toHaveBeenCalledTimes(1);
    expect(env.contexts[0]).toContain('File: tests/manifest.test.ts');
    expect(env.contexts[0]).toContain('Clicked line: removed, line 62 of the old file');
    expect(env.contexts[0]).toMatch(/^>- {4}'https:\/\/github\.com\/owner\/repo',$/m);
  });

  it('explains lines in every file of a long PR, each added as you scroll', () => {
    for (let i = 0; i < 60; i++) {
      const html = fixture('github-diff-new.html').replace(
        'Diff for: docs/roadmap.md',
        `Diff for: src/file${i}.ts`,
      );
      loadLater(html);
    }
    const lines = document.querySelectorAll(`td[data-line-anchor="${ANCHOR}R44"]`);
    expect(lines).toHaveLength(60);
    click(lines[59]!);
    click(lines[0]!);
    expect(env.contexts.map((c) => /^File: (\S+)/.exec(c)?.[1])).toEqual([
      'src/file59.ts',
      'src/file0.ts',
    ]);
  });

  it('selects a block in a file added later', () => {
    loadLater(fixture('github-diff-classic-split.html'));
    const rows = [...document.querySelectorAll('tbody tr')].filter((r) => r.children.length === 4);
    click(rows[2]!.children[3]!);
    click(rows[6]!.children[3]!, { shiftKey: true });
    const button = document.getElementById(SELECTION_UI_ID)?.shadowRoot?.querySelector('button');
    expect(button?.textContent).toBe('Explain selection (5 lines)');
  });

  it('stops explaining late diffs once click-to-explain is taken off', () => {
    env.detach();
    loadLater(fixture('github-diff-classic.html'));
    click(added44());
    expect(env.deps.explain).not.toHaveBeenCalled();
  });
});
