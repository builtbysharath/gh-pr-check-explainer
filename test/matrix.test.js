import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
import {analyze, jobCheckNames} from '../src/analyze.js';

// Check run names GitHub Actions created for these workflows on 2026-10-11.
const RECORDED = {
  'matrix-names-1.yml': ['Lint (a)', 'Named job (22)', 'Named job (24)', 'Test on 22', 'exclude (a, 1)', 'exclude (a, 2)', 'exclude (b, 1)',
    'include (a)', 'include (b)', 'include (c)', 'includeorder (a)', 'keyorder (z, a)', 'object (x, 1)', 'onlyinclude (a, 1)', 'onlyinclude (b)',
    'plain (ubuntu-latest, 22)', 'plain (ubuntu-latest, 24)', 'scalars (true, 1.5, hello world)', 'single (only)'],
  // "Plain push" comes from ${{ github.event_name }}, which depends on the event and is not predicted.
  'matrix-names-2.yml': ['Use p', 'conflict (a, 1)', 'conflict (a, 2)', 'conflict (b, 1)', 'everywhere (a)', 'everywhere (b)', 'nested (1, 2, 3)',
    'newextra (a)', 'newextra (c, y)', 'numbers (1000)', 'numbers (16)', 'numbers (22)', 'numbers (22.0)', 'numbers (7)', 'x']
};

test('matrix job names match the check runs GitHub created', () => {
  for (const [file, recorded] of Object.entries(RECORDED)) {
    const workflow = parse(readFileSync(new URL('./fixtures/' + file, import.meta.url), 'utf8'));
    const names = [];
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const result = jobCheckNames(id, job);
      if (id === 'nomatrix') assert.equal(result, null);
      else names.push(...result);
    }
    assert.deepEqual(names.sort(), [...recorded].sort(), file);
  }
});

test('matrix names that depend on expressions stay unexplained', () => {
  for (const job of [
    {strategy: {matrix: '${{ fromJSON(needs.setup.outputs.matrix) }}'}},
    {strategy: {matrix: {os: '${{ fromJSON(inputs.os) }}'}}},
    {strategy: {matrix: {os: ['${{ inputs.os }}']}}},
    {strategy: {matrix: {os: [null]}}},
    {strategy: {matrix: {include: '${{ fromJSON(inputs.include) }}'}}},
    {name: 'Build ${{ inputs.target }}', strategy: {matrix: {os: ['a']}}},
    {uses: './.github/workflows/reusable.yml'}
  ]) assert.equal(jobCheckNames('build', job), null, JSON.stringify(job));
  assert.deepEqual(jobCheckNames('build', {}), ['build']);
  assert.deepEqual(jobCheckNames('build', {name: 'Build'}), ['Build']);
  assert.equal(jobCheckNames('build', {strategy: {matrix: {a: Array.from({length: 17}, (_, i) => i), b: Array.from({length: 17}, (_, i) => i)}}}), null);
});

test('matrix names follow GitHub for variable case, missing properties, line breaks and skipped jobs', () => {
  // Matrix variable names are case-insensitive.
  assert.deepEqual(jobCheckNames('t', {name: 'Test ${{ matrix.OS }}', strategy: {matrix: {os: ['ubuntu-latest']}}}), ['Test ubuntu-latest']);
  assert.deepEqual(jobCheckNames('t', {strategy: {matrix: {os: ['a', 'b'], exclude: [{OS: 'b'}]}}}), ['t (a)']);
  assert.deepEqual(jobCheckNames('t', {strategy: {matrix: {os: ['a'], include: [{OS: 'b', extra: 'x'}]}}}), ['t (a)', 't (b, x)']);
  // A property the matrix doesn't have is empty, even one every JavaScript object has.
  assert.deepEqual(jobCheckNames('t', {name: 'Check ${{ matrix.constructor }}x', strategy: {matrix: {os: ['a']}}}), ['Check x']);
  assert.deepEqual(jobCheckNames('t', {name: 'Test ${{\n  matrix.os\n}}', strategy: {matrix: {os: ['a']}}}), ['Test a']);
  // When its if condition skips a matrix job, GitHub reports one check named without the matrix values.
  assert.deepEqual(jobCheckNames('build', {if: "github.event_name == 'push'", strategy: {matrix: {os: ['a', 'b']}}}), ['build (a)', 'build (b)', 'build']);
});

test('a required matrix check skipped by a path filter is explained', () => {
  const snapshot = JSON.parse(readFileSync(new URL('../examples/path-filter.json', import.meta.url), 'utf8'));
  snapshot.workflows.data[0].text = "name: Build\non:\n  pull_request:\n    paths:\n      - 'src/**'\njobs:\n  build:\n    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n    runs-on: ${{ matrix.os }}\n    steps:\n      - run: npm test\n";
  snapshot.rulesets.checks = [{...snapshot.rulesets.checks[0], context: 'build (macos-latest)'}];
  const report = analyze(snapshot);
  assert.equal(report.checks[0].cause, 'workflow_filtered');
  assert.ok(!report.limitations.some(note => note.startsWith('Dynamic matrix names')));
});
