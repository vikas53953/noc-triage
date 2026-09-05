/* cw12-fixture.js — DEV / REVIEW ONLY. Not loaded by the app.
 *
 * Plain words: paste this into the browser console on /desk.html (or /) to see
 * the presence line and the receipt ticks WITHOUT a live model or a live
 * device. Every envelope below is invented FOR THE LOOK ONLY and says so; in
 * the product these envelopes are only ever sent by the server while a model
 * call / agent read / approval wait is REALLY in flight (sources/presence.js).
 *
 * THE WIRE SHAPE (pinned with the backend):
 *   {type:'presence', data:{ actor, actorName, state, id, since?, at,
 *                            requestId?, clientMessageId?, label?, reason? }}
 *   state ∈ picked-up | thinking | typing | checking | waiting-approval | done
 *
 * It uses the marked dev hooks: window.__cw12DevPresence(data) for one
 * envelope, window.__cw12DevSend(text) (desk) to paint a tagged operator
 * bubble, window.__cw12DevChat(msg) for a chat message, __cw12DevSeed(list)
 * for a reconnect snapshot, __cw12DevDrop() for a socket drop.
 *
 * Use:
 *   cw12Typing()        — Jarvis thinking → typing → done (line appears, changes, clears)
 *   cw12Squad()         — three agents checking at once, then one by one done
 *   cw12Approval()      — an agent waiting for your approval (amber, no dots), then decided
 *   cw12Receipts()      — your message: sent ✓ → picked up ✓✓ → answered ✓✓ (blue)
 *   cw12Abort()         — a model call that dies mid-way: the line must clear at once
 *   cw12Xss()           — hostile actor names: printed, never executed
 *   cw12Reconnect()     — a socket drop clears the line; the snapshot brings back only what is live
 *   cw12Ghost()         — a 'done' for a flight never seen: nothing appears
 *   cw12All()           — everything, in order
 */

var CW12_TAG = ' [FIXTURE — invented, not a real event]';

function cw12P(d){
  if (typeof window !== 'undefined' && window.__cw12DevPresence) return window.__cw12DevPresence(d);
  console.log('open /desk.html or / first');
}
function cw12Now(){ return new Date().toISOString(); }
function cw12Env(actor, name, state, id, extra){
  return Object.assign({ actor: actor, actorName: name, state: state, id: id, at: cw12Now(), since: cw12Now() }, extra || {});
}
function cw12Wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

async function cw12Typing(){
  cw12P(cw12Env('jarvis', 'Jarvis', 'thinking', 'call-fx-1', { label: 'plan' + CW12_TAG }));
  await cw12Wait(1200);
  cw12P(cw12Env('jarvis', 'Jarvis', 'typing', 'call-fx-1', { label: 'synthesis' + CW12_TAG }));
  await cw12Wait(1800);
  cw12P(cw12Env('jarvis', 'Jarvis', 'done', 'call-fx-1', { reason: 'done' }));
  console.log('cw12Typing: the line should now be GONE (hidden), not idle text');
}

async function cw12Squad(){
  cw12P(cw12Env('router-expert', 'Router-Expert', 'checking', 'router-expert', { label: 'Reading a device via Command Runner' + CW12_TAG }));
  await cw12Wait(400);
  cw12P(cw12Env('netops', 'NetOps', 'checking', 'netops', { label: 'Catalyst health' + CW12_TAG }));
  await cw12Wait(400);
  cw12P(cw12Env('config-keeper', 'Config-Keeper', 'checking', 'config-keeper'));
  await cw12Wait(400);
  cw12P(cw12Env('sentinel', 'Sentinel', 'checking', 'sentinel'));
  console.log('cw12Squad: three named + "and 1 more"');
  await cw12Wait(1500);
  cw12P(cw12Env('netops', 'NetOps', 'done', 'netops'));
  await cw12Wait(600);
  cw12P(cw12Env('sentinel', 'Sentinel', 'done', 'sentinel'));
  await cw12Wait(600);
  cw12P(cw12Env('config-keeper', 'Config-Keeper', 'done', 'config-keeper'));
  await cw12Wait(600);
  cw12P(cw12Env('router-expert', 'Router-Expert', 'done', 'router-expert'));
}

async function cw12Approval(){
  cw12P(cw12Env('config-keeper', 'Config-Keeper', 'waiting-approval', 'apr:fx-1', { label: 'show running-config' + CW12_TAG }));
  console.log('cw12Approval: amber "is waiting for your approval", NO typing dots');
  await cw12Wait(2500);
  cw12P(cw12Env('config-keeper', 'Config-Keeper', 'done', 'apr:fx-1', { reason: 'denied' }));
}

async function cw12Receipts(){
  var cmid = window.__cw12DevSend ? window.__cw12DevSend('is sw1 healthy?' + CW12_TAG) : null;
  if (!cmid) { console.log('receipts demo is desk-only (the classic page tags from the server echo)'); return; }
  console.log('sent ✓');
  await cw12Wait(800);
  /* the server's echo of our message teaches the requestId → cmid pair */
  window.__cw12DevChat({ type: 'outgoing', agent: 'jarvis', text: 'is sw1 healthy?', requestId: 'req-fx-1', clientMessageId: cmid, timestamp: cw12Now() });
  cw12P(cw12Env('jarvis', 'Jarvis', 'picked-up', 'pickup-fx-1', { requestId: 'req-fx-1', clientMessageId: cmid }));
  console.log('picked up ✓✓');
  await cw12Wait(1200);
  window.__cw12DevChat({ type: 'incoming', agent: 'jarvis', agentName: 'Jarvis', agentIcon: '🧠', requestId: 'req-fx-1',
    text: 'sw1 answered show version: IOS-XE 17.12.01. Nothing points at a fault.' + CW12_TAG, timestamp: cw12Now() });
  console.log('answered ✓✓ (blue)');
}

async function cw12Abort(){
  cw12P(cw12Env('jarvis', 'Jarvis', 'typing', 'call-fx-2'));
  await cw12Wait(900);
  cw12P(cw12Env('jarvis', 'Jarvis', 'done', 'call-fx-2', { reason: 'aborted' }));
  console.log('cw12Abort: the line must be gone NOW — nothing lingers on a dead call');
}

async function cw12Xss(){
  var evil = '<img src=x onerror=alert(1)>';
  cw12P(cw12Env('x' + evil, evil, 'typing', 'xss-1', { label: evil }));
  console.log('cw12Xss: the tag text is PRINTED in the line; no alert');
  await cw12Wait(1500);
  cw12P(cw12Env('x' + evil, evil, 'done', 'xss-1'));
}

async function cw12Reconnect(){
  cw12P(cw12Env('jarvis', 'Jarvis', 'typing', 'call-fx-3'));
  cw12P(cw12Env('netops', 'NetOps', 'checking', 'netops'));
  await cw12Wait(900);
  window.__cw12DevDrop();
  console.log('cw12Reconnect: socket dropped — line gone');
  await cw12Wait(900);
  window.__cw12DevSeed([cw12Env('netops', 'NetOps', 'checking', 'netops')]);
  console.log('cw12Reconnect: snapshot says only NetOps is still live — only NetOps shows');
  await cw12Wait(1200);
  cw12P(cw12Env('netops', 'NetOps', 'done', 'netops'));
}

function cw12Ghost(){
  cw12P(cw12Env('jarvis', 'Jarvis', 'done', 'never-started'));
  console.log('cw12Ghost: nothing should have appeared');
}

async function cw12All(){
  await cw12Typing(); await cw12Squad(); await cw12Approval(); await cw12Receipts();
  await cw12Abort(); await cw12Xss(); await cw12Reconnect(); cw12Ghost();
}
console.log('CW-12 fixture loaded: cw12Typing() cw12Squad() cw12Approval() cw12Receipts() cw12Abort() cw12Xss() cw12Reconnect() cw12Ghost() cw12All()');
