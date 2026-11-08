// Ordering and cycle checks for transformed tables (src/shared/dependencies.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildOrder,
  directDependents,
  downstreamOf,
  findCycle,
  type DependencyMap,
} from '../../src/shared/dependencies.ts';

// Transformed tables: by_region reads the loaded table sales; top_regions reads by_region;
// report reads both, plus the loaded table targets.
const deps: DependencyMap = {
  report: ['by_region', 'top_regions', 'targets'],
  top_regions: ['by_region'],
  by_region: ['sales'],
};

test('buildOrder puts each table after the transformed tables it reads', () => {
  assert.deepEqual(buildOrder(deps), {
    order: ['by_region', 'top_regions', 'report'],
    blocked: [],
  });
});

test('buildOrder treats names that are not transformed tables as already built', () => {
  assert.deepEqual(buildOrder({ a: ['loaded_1', 'loaded_2'] }).order, ['a']);
});

test('buildOrder leaves tables in a circular reference, and those downstream, blocked', () => {
  const result = buildOrder({ a: ['b'], b: ['a'], c: ['a'], d: ['sales'] });
  assert.deepEqual(result.order, ['d']);
  assert.deepEqual(result.blocked.sort(), ['a', 'b', 'c']);
});

test('buildOrder blocks a table that reads itself', () => {
  assert.deepEqual(buildOrder({ a: ['a'] }), { order: [], blocked: ['a'] });
});

test('findCycle returns the path of a circular reference', () => {
  assert.deepEqual(findCycle({ ...deps, by_region: ['report'] }, 'by_region'), [
    'by_region',
    'report',
    'by_region',
  ]);
  assert.deepEqual(findCycle({ a: ['b'], b: ['c'], c: ['a'] }, 'a'), [
    'a',
    'b',
    'c',
    'a',
  ]);
});

test('findCycle spots a table reading itself', () => {
  assert.deepEqual(findCycle({ a: ['a'] }, 'a'), ['a', 'a']);
});

test('findCycle returns null when there is no cycle', () => {
  assert.equal(findCycle(deps, 'report'), null);
  assert.equal(findCycle(deps, 'by_region'), null);
});

test('findCycle ignores cycles the table is not part of', () => {
  assert.equal(findCycle({ x: ['a'], a: ['b'], b: ['a'] }, 'x'), null);
});

test('directDependents lists the transformed tables that read a table', () => {
  assert.deepEqual(directDependents(deps, 'by_region'), [
    'report',
    'top_regions',
  ]);
  assert.deepEqual(directDependents(deps, 'sales'), ['by_region']);
  assert.deepEqual(directDependents(deps, 'report'), []);
});

test('downstreamOf lists everything affected by a change, in build order', () => {
  assert.deepEqual(downstreamOf(deps, ['sales']), [
    'by_region',
    'top_regions',
    'report',
  ]);
  assert.deepEqual(downstreamOf(deps, ['targets']), ['report']);
  assert.deepEqual(downstreamOf(deps, ['top_regions']), ['report']);
  assert.deepEqual(downstreamOf(deps, ['unrelated']), []);
});
