import test from 'node:test';
import assert from 'node:assert/strict';
import {lessonFromHash, lessonHash, adjacentKeyframe, shortcutFor} from '../app/navigation.js';

test('lesson links round-trip ids, including characters that need escaping', () => {
  for (const id of ['cover-2', 'route-hitch', '自编 战术#1', 'a/b?c']) assert.equal(lessonFromHash(lessonHash(id)), id);
  for (const hash of ['', '#', '#cover-2', '#lesson=', '#lessons=cover-2']) assert.equal(lessonFromHash(hash), undefined, hash);
  assert.equal(lessonFromHash('#lesson=%E0%A4%A'), undefined, 'malformed escapes are ignored');
});

test('keyframe stepping moves between frames and stops at either end', () => {
  const frames = [0, 2, 5.5, 10].map(at => ({at}));
  assert.equal(adjacentKeyframe(frames, 0, 1).at, 2);
  assert.equal(adjacentKeyframe(frames, 3, 1).at, 5.5);
  assert.equal(adjacentKeyframe(frames, 5.5, -1).at, 2);
  assert.equal(adjacentKeyframe(frames, 10, 1).at, 10);
  assert.equal(adjacentKeyframe(frames, 0, -1).at, 0);
  assert.equal(adjacentKeyframe([], 1, 1), undefined);
});

test('shortcuts map keys to actions and stay out of typing and focused buttons', () => {
  const key = (value, modifiers = {}) => ({key: value, altKey: false, ctrlKey: false, metaKey: false, ...modifiers});
  assert.deepEqual(shortcutFor(key(' ')), {type: 'toggle'});
  assert.deepEqual(shortcutFor(key('k')), {type: 'toggle'});
  assert.equal(shortcutFor(key(' '), {onControl: true}), null, 'Space keeps activating a focused button');
  assert.deepEqual(shortcutFor(key('k'), {onControl: true}), {type: 'toggle'});
  assert.deepEqual(shortcutFor(key('ArrowLeft')), {type: 'keyframe', direction: -1});
  assert.deepEqual(shortcutFor(key(']')), {type: 'lesson', direction: 1});
  assert.deepEqual(shortcutFor(key('[')), {type: 'lesson', direction: -1});
  assert.deepEqual(['1', '2', '3', '4'].map(value => shortcutFor(key(value)).value), [.5, 1, 2, 3]);
  assert.deepEqual(shortcutFor(key('0')), {type: 'reset'});
  assert.deepEqual(shortcutFor(key('f')), {type: 'fullscreen'});
  assert.deepEqual(shortcutFor(key('F')), {type: 'fullscreen'});
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) assert.equal(shortcutFor(key('1', {[modifier]: true})), null, modifier);
  for (const value of [' ', 'ArrowRight', '1', ']']) assert.equal(shortcutFor(key(value), {typing: true}), null, `typing ${value}`);
  assert.equal(shortcutFor(key('x')), null);
});
