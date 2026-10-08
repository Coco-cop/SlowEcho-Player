'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
for (const file of scripts) {
  new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), {filename: file});
}
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
  if (match[1].trim()) new vm.Script(match[1], {filename: 'index.html inline script'});
}

class CustomEvent extends Event {
  constructor(type, options) { super(type); this.detail = options?.detail; }
}
const sandbox = {
  console, EventTarget, CustomEvent,
  document: {getElementById: () => null, querySelector: () => null},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const file of ['js/runtime.js', 'js/subtitle-parser.js', 'js/playback.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, {filename: file});
}
assert.equal(sandbox.EchoPlayer.failures.length, 0);
const parser = sandbox.EchoPlayer.modules['subtitle-parser'];
const playback = sandbox.EchoPlayer.modules.playback;
const plain = value => JSON.parse(JSON.stringify(value));

const srt = '\uFEFF2\r\n00:00:04,000 --> 00:00:06,000\r\nNext sentence.\r\n\r\n' +
  '1\r\n00:00:01,000 --> 00:00:03,000\r\n<i>Hello &amp; welcome.</i>\r\n你好。\r\n';
const cues = plain(parser.parseSubtitle(srt));
assert.deepEqual(cues, [
  {start:1,end:3,text:'Hello & welcome.',zh:'你好。'},
  {start:4,end:6,text:'Next sentence.'},
]);
assert.deepEqual(plain(parser.parseSubtitle('WEBVTT\n\n00:01.000 --> 00:02.500 align:start\nA sentence.')),
  [{start:1,end:2.5,text:'A sentence.'}]);
assert.equal(parser.parseSubtitle('Not a timed subtitle').length, 0);

// Real-time ticks can overshoot the boundary; the explicitly selected sentence stays locked.
const locked = {segments:cues, active:0, loop:true, locked:0};
assert.deepEqual(plain(playback.planTick(locked, 4.5)), {active:0,seekTo:1,repeat:true});
assert.deepEqual(plain(playback.planTick(locked, 2)), {active:0,seekTo:null,repeat:false});
assert.equal(playback.planTick({...locked,loop:false}, 4.5).active, 1);
assert.equal(playback.segAt(cues, 3.5), -1);
assert.deepEqual(plain(playback.planEnded({...locked,locked:1})), {seekTo:4,repeat:true});
assert.equal(playback.planEnded({...locked,loop:false}).repeat, false);
assert.deepEqual(plain(playback.shiftSegments(cues, -2)), [{start:0,end:1},{start:2,end:4}]);
assert.equal(cues[0].start, 1, 'offset must not mutate the stored subtitle timeline');
console.log(`Passed: ${scripts.length} script syntax checks, subtitle parsing and sentence-loop cases.`);
