import { renderMarkdown } from '../src/popup/renderMarkdown';

function render(markdown: string): HTMLElement {
  const div = document.createElement('div');
  div.append(renderMarkdown(document, markdown));
  return div;
}

describe('renderMarkdown', () => {
  it('splits paragraphs on blank lines and keeps line breaks', () => {
    expect(render('one\ntwo\n\nthree').innerHTML).toBe('<p>one<br>two</p><p>three</p>');
  });

  it('renders inline code, bold, and italic', () => {
    expect(render('Use `a ** b` with **care** and *thought*').innerHTML).toBe(
      '<p>Use <code>a ** b</code> with <strong>care</strong> and <em>thought</em></p>',
    );
  });

  it('leaves a lone asterisk and snake_case alone', () => {
    expect(render('a * b and my_var_name').innerHTML).toBe('<p>a * b and my_var_name</p>');
  });

  it('renders bullet and numbered lists, with continuation lines', () => {
    expect(render('- one\n  more\n* two\n\n1. first\n2) second').innerHTML).toBe(
      '<ul><li>one<br>more</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>',
    );
  });

  it('renders fenced code blocks literally', () => {
    expect(render('```ts\nconst a = **b**;\n```\nafter').innerHTML).toBe(
      '<pre><code>const a = **b**;</code></pre><p>after</p>',
    );
  });

  it('shows headings inside a section in bold', () => {
    expect(render('### Note').innerHTML).toBe('<p><strong>Note</strong></p>');
  });

  it('shows links as their text only', () => {
    expect(render('see [docs](https://example.com)').innerHTML).toBe('<p>see docs</p>');
    expect(render('[x](javascript:alert(1)) done').innerHTML).toBe('<p>x done</p>');
  });

  it('escapes raw HTML instead of parsing it', () => {
    expect(render('<b>hi</b> & <img src=x>').innerHTML).toBe(
      '<p>&lt;b&gt;hi&lt;/b&gt; &amp; &lt;img src=x&gt;</p>',
    );
  });
});
