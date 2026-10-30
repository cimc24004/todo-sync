'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function setup(t, {muted = false, reducedMotion = false, blockedAudio = false, motionPreference = null} = {}) {
  const base = path.join(__dirname, '../src');
  const dom = new JSDOM(fs.readFileSync(path.join(base, 'index.html'), 'utf8'), {runScripts: 'outside-only', url: 'https://example.test'});
  const w = dom.window, d = w.document, played = [];
  t.after(() => w.close());
  w.matchMedia = () => ({matches: reducedMotion});
  w.Audio = class {
    constructor(src) {this.src = src;}
    canPlayType() {return 'probably';}
    pause() {}
    play() {played.push({src: this.src, volume: this.volume}); return blockedAudio ? Promise.reject(Error('Autoplay blocked')) : Promise.resolve();}
  };
  if (muted) w.localStorage.setItem('michi-feedback-sound-v1', 'off');
  if (motionPreference) w.localStorage.setItem('michi-feedback-motion-v1', motionPreference);
  Object.defineProperty(w.navigator, 'locks', {value: {request: async (name, options, fn) => fn({name})}});
  w.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  w.HTMLDialogElement.prototype.close = function () {this.open = false;};
  for (const file of ['config.js', 'sync-core.js', 'drive-sync.js', 'data-adapter.js', 'renderer.js']) w.eval(fs.readFileSync(path.join(base, file), 'utf8'));
  await tick();
  const click = selector => d.querySelector(selector).click();
  async function add() {
    click('#new');
    d.querySelector('[name=title]').value = '次の一歩';
    d.querySelector('#form').dispatchEvent(new w.Event('submit', {cancelable: true}));
    await tick();
  }
  return {w, d, played, click, add};
}

test('feedback follows successful user actions; initial load and sync stay silent', async t => {
  const {w, d, played, click, add} = await setup(t);
  assert.equal(played.length, 0);
  await add();
  assert.deepEqual(played.map(p => path.basename(p.src)), ['click.ogg', 'click.ogg']);
  assert.ok(d.querySelector('.task.task-enter'));
  click('.check');
  await tick();
  assert.equal(played.at(-1).src, 'assets/sounds/complete.ogg');
  assert.equal(d.querySelector('#done-count').textContent, '1');
  assert.ok(d.querySelector('#done-count').classList.contains('count-bump'));
  assert.match(d.querySelector('#toast').textContent, /ひとつ完了/);
  assert.ok(played.every(p => p.volume > 0 && p.volume <= .50));
  const count = played.length;
  w.dispatchEvent(new w.Event('michi-data-changed'));
  w.dispatchEvent(new w.CustomEvent('michi-sync-state', {detail: {connected: true, pending: 0}}));
  await tick();
  assert.equal(played.length, count);
  click('[data-filter=completed]');
  click('.check');
  await tick();
  assert.equal(played.at(-1).src, 'assets/sounds/click.ogg');
});

test('muted preference survives startup and can be toggled with accessible state', async t => {
  const {w, d, played, click, add} = await setup(t, {muted: true});
  assert.equal(d.querySelector('#sound-toggle').getAttribute('aria-pressed'), 'false');
  await add();
  click('.check');
  await tick();
  assert.equal(played.length, 0);
  click('#sound-toggle');
  assert.equal(w.localStorage.getItem('michi-feedback-sound-v1'), 'on');
  assert.equal(d.querySelector('#sound-toggle').getAttribute('aria-label'), '操作音をオフにする');
  assert.equal(played.length, 1);
  click('#sound-toggle');
  assert.equal(w.localStorage.getItem('michi-feedback-sound-v1'), 'off');
  assert.equal(played.length, 1);
});

test('explicit motion off and blocked audio preserve task actions; failed writes do not celebrate', async t => {
  const {w, d, played, click, add} = await setup(t, {reducedMotion: true, motionPreference: 'off', blockedAudio: true});
  await add();
  assert.equal(d.querySelectorAll('.task').length, 1);
  assert.equal(d.querySelectorAll('.task-enter,.editor-enter,.toast-enter').length, 0);
  const original = w.todoClient.request;
  w.todoClient.request = async (action, payload) => action === 'toggle' ? {ok: false, error: '保存できません'} : original(action, payload);
  const count = played.length;
  click('.check');
  await tick();
  assert.equal(played.length, count);
  assert.equal(d.querySelector('#done-count').textContent, '0');
  assert.equal(d.querySelector('#toast').textContent, '保存できません');
  assert.equal(d.querySelector('.completion-toast'), null);
});

test('completion waits for persistence and survives sync refresh until the row collapses', async t => {
  const {w, d, played, click, add} = await setup(t);
  await add();
  const row=d.querySelector('.task'),original=w.todoClient.request;
  let saved;
  const gate=new Promise(resolve=>{saved=resolve;});
  w.todoClient.request=async(action,payload)=>{if(action==='toggle')await gate;return original(action,payload);};
  click('.check');
  await tick();
  assert.equal(d.querySelector('.task-completing'),null);
  assert.equal(played.some(p=>p.src.endsWith('complete.ogg')),false);
  w.dispatchEvent(new w.Event('michi-data-changed'));
  await tick();
  assert.equal(d.querySelector('.task'),row);
  saved();
  await tick();
  assert.equal((await original('list')).data.tasks[0].done,true);
  assert.equal(d.querySelector('.task-completing'),row);
  assert.equal(row.querySelector('.check').textContent,'✓');
  assert.equal(d.querySelectorAll('.completion-burst i').length,28);
  w.dispatchEvent(new w.Event('michi-data-changed'));
  await tick();
  assert.equal(d.querySelector('.task-completing'),row);
  await new Promise(resolve=>setTimeout(resolve,600));
  assert.equal(d.querySelector('.task'),null);
  assert.ok(d.querySelector('.completion-burst'),'the burst outlives the collapsed row');
});

test('motion starts enabled and the application switch can explicitly disable it', async t => {
  const {w,d,click,add}=await setup(t,{reducedMotion:true,muted:true});
  assert.equal(d.querySelector('#motion-toggle').getAttribute('aria-pressed'),'true');
  assert.equal(d.documentElement.dataset.motion,'on');
  await add();
  assert.ok(d.querySelector('.task-enter'));
  click('.check');await tick();
  assert.ok(d.querySelector('.task-completing'));
  click('#motion-toggle');
  assert.equal(d.documentElement.dataset.motion,'off');
  assert.equal(d.querySelector('.completion-burst'),null);
  assert.equal(d.querySelector('.task'),null);
});

test('saved motion choice restores and sync does not start filter entry animations', async t => {
  const {w,d,click,add}=await setup(t,{reducedMotion:true,motionPreference:'on'});
  assert.equal(d.querySelector('#motion-toggle').getAttribute('aria-pressed'),'true');
  await add();
  click('[data-filter=all]');
  assert.ok(d.querySelector('.task-filter-enter'));
  w.dispatchEvent(new w.Event('michi-data-changed'));await tick();
  assert.equal(d.querySelector('.task-filter-enter'),null);
  click('.check');await tick();
  click('[data-filter=completed]');
  assert.equal(d.querySelector('.task-completing'),null);
  assert.equal(d.querySelectorAll('.task.done').length,1);
});

