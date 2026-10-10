import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {analyze} from '../src/analyze.js';
import {html, markdown} from '../src/render.js';
import {copyScript} from '../src/copy.js';

const fixture = JSON.parse(readFileSync(new URL('../examples/path-filter.json', import.meta.url), 'utf8'));
test('hosted example has navigation and labelled non-clickable evidence, including copied Markdown', () => {
  const report = analyze(fixture), output = html(report, {example: true});
  assert.match(output, /href="\.\/">Back to overview/);
  assert.match(output, /href="\.\/#try">Try on your PR/);
  assert.match(output, /synthetic example/);
  assert.match(output, /run the read-only CLI on your computer/);
  assert.match(output, /Example evidence: Required by main branch ruleset/);
  assert.match(output, /Example evidence: \.github\/workflows\/build.yml/);
  assert.ok(!output.includes('https://github.com/example/'));
  assert.ok(!markdown(report, {example: true}).includes('https://github.com/example/'));
});
test('standalone report keeps real evidence and has no relative assets or overview links', () => {
  const report = analyze(fixture);
  report.checks[0].evidence = [
    {label: 'Real evidence', url: 'https://github.com/builtbysharath/gh-pr-check-explainer/actions/runs/1'},
    {label: '<unsafe>', detail: '</script><script>alert(1)</script>', url: 'https://github.com.evil.test/x'},
    {label: 'Unsafe scheme', url: 'javascript:alert(1)'}
  ];
  const output = html(report);
  assert.match(output, /href="https:\/\/github.com\/builtbysharath\//);
  assert.ok(!output.includes('Back to overview'));
  assert.ok(!/\b(?:href|src)="\.\//.test(output));
  assert.ok(!output.includes('href="https://github.com.evil.test/'));
  assert.ok(!output.includes('href="javascript:'));
  assert.ok(output.includes('&lt;unsafe&gt;'));
  assert.ok(!output.includes('<script>alert(1)</script>'));
  const scripts = [...output.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const digest = createHash('sha256').update(scripts[0][1]).digest('base64');
  assert.ok(output.includes("script-src 'sha256-" + digest + "'"));
  assert.ok(output.includes("connect-src 'none'"));
  assert.ok(!output.includes("script-src 'unsafe-inline'"));
  assert.match(output, /role="status" aria-live="polite"/);
});

function copyHarness({value, textContent, clipboard}) {
  const target = {value, textContent}, status = {textContent: ''};
  const button = {dataset: {copyTarget: 'target', copyStatus: 'status'}, addEventListener(_, fn) {this.click = fn;}};
  vm.runInNewContext(copyScript, {document: {querySelectorAll: () => [button], getElementById: id => id === 'target' ? target : status}, navigator: {clipboard}});
  return {button, status};
}
test('Copy Markdown and Copy command write the exact displayed text and announce success', async () => {
  for (const target of [{value: '# Markdown\n<literal>\n'}, {textContent: 'npm exec --yes \\\n  -- gh-pr-check-explainer --repo OWNER/REPO --pr NUMBER'}]) {
    let copied;
    const ui = copyHarness({...target, clipboard: {writeText: async text => {copied = text;}}});
    await ui.button.click();
    assert.equal(copied, target.value ?? target.textContent);
    assert.equal(ui.status.textContent, 'Copied to clipboard.');
    assert.equal(ui.button.disabled, false);
  }
});
test('clipboard denial or absence announces failure and leaves manual selection available', async () => {
  for (const clipboard of [undefined, {writeText: async () => {throw new Error('denied');}}]) {
    const ui = copyHarness({value: '# report', clipboard});
    await ui.button.click();
    assert.equal(ui.status.textContent, 'Could not copy. Select the text and copy it manually.');
    assert.equal(ui.button.disabled, false);
  }
});
