/* cw9-envelope-fixture.js — DEV / REVIEW ONLY. Not loaded by the app.
 *
 * Plain words: this is a paste-into-the-browser-console script that replays the
 * EPG bridge call from docs/copilot-cw9-bridge-contract.md through the DESK's
 * real renderers, so the V2 split terminal can be looked at without waiting for
 * the backend branch. It calls window.__cw9DevInject(msg) — the marked dev hook
 * in public/desk.html — with messages in the PINNED envelope shape.
 *
 * Nothing in the product calls this file. It reads nothing and writes nothing;
 * every string below is made up FOR THE LOOK ONLY and is labelled as such, so it
 * can never be mistaken for a real device read.
 *
 * Use: open /desk.html, open the console, paste this file, run cw9Demo().
 */
var CW9_FIXTURE = [
  {
    role: 'jarvis', kind: 'ask',
    text: 'On it. Before I pull anyone in — three quick ones:',
    questions: [
      'Which tenant / EPG — or just the app or IP that is affected?',
      'What is failing — who cannot reach what?',
      'Since when? Any change around that time?',
    ],
    resume: '/api/command',
    timestamp: new Date().toISOString(),
  },
  {
    role: 'jarvis', kind: 'roster',
    text: 'That scopes it. Opening the bridge — I only need the fabric engineer.',
    roster: {
      engaged: [{ agent: 'Router-Expert', why: 'owns the ACI fabric this EPG lives on' }],
      stoodDown: [
        { agent: 'Monitor-Eye', why: 'no alarm outside the fabric' },
        { agent: 'WAN-Watch', why: 'the path never leaves the data centre' },
        { agent: 'Config-Keeper', why: 'no config change in the window' },
      ],
    },
    timestamp: new Date().toISOString(),
  },
  {
    role: 'agent', kind: 'finding',
    finding: {
      agent: 'Router-Expert',
      line: 'Fault F0467 on that EPG — path binding down on Leaf-101 eth1/5, raised 10:18.',
      cli: {
        host: 'apic1',
        transport: 'ssh',
        command: 'moquery -c faultInst -f \'fault.Inst.dn*"APP-VIKAS-1"\'',
        output:
          'F0467  uni/tn-ACI-FIRST-TENENT/ap-APP/epg-APP-VIKAS-1\n' +
          '  severity : major   lc: raised   created: 10:18:44\n' +
          '  descr    : Fault delegate: invalid path binding\n' +
          '             Leaf-101 eth1/5 — vlan-1103 not resolved\n' +
          '  [FIXTURE — invented sample output, not a real read]',
      },
    },
    timestamp: new Date().toISOString(),
  },
  {
    role: 'agent', kind: 'finding',
    finding: {
      agent: 'Config-Keeper',
      line: 'eth1/5 is down (sfpAbsent), flapped 10:17 — and VLAN 1103 is gone from the port config.',
      cli: {
        host: 'Leaf-101',
        transport: 'cmdrunner',
        command: 'show interface ethernet 1/5',
        output:
          'Ethernet1/5 is down (sfpAbsent)\n' +
          '  Hardware: 1000/10000 Ethernet, address: 00a3.8e21.b405\n' +
          '  Last link flapped: 10:17:52\n' +
          'VLAN 1103 : not found in current port config\n' +
          '  [FIXTURE — invented sample output, not a real read]',
      },
    },
    timestamp: new Date().toISOString(),
  },
  {
    role: 'jarvis', kind: 'verdict',
    verdict: {
      cause: 'Leaf-101 eth1/5 went down at 10:17 (SFP not detected) and its VLAN binding dropped, so EPG APP-VIKAS-1 lost its path.',
      confidence: 'high', rounds: 2,
    },
    timestamp: new Date().toISOString(),
  },
  {
    role: 'jarvis', kind: 'change',
    change: {
      id: 'CHG-20260820-014',
      state: 'held-for-approval',
      steps: ['Reseat or replace the SFP on Leaf-101 eth1/5.', 'Re-bind vlan-1103 static path on the EPG.'],
    },
    timestamp: new Date().toISOString(),
  },
];

/* Hostile-input check: paste and run cw9DemoXss() to see that raw device text
   is printed, never executed. */
var CW9_FIXTURE_XSS = {
  role: 'agent', kind: 'finding',
  finding: {
    agent: '<img src=x onerror=alert(1)>',
    line: 'Hostile output test — <script>alert("chat")</script>',
    cli: {
      host: '<b>sw1</b>', transport: 'telnet',
      command: 'show run | i <script>alert("cmd")</script>',
      output: '<script>alert("term")</script>\nInterface is down\n  [FIXTURE]',
    },
  },
  timestamp: new Date().toISOString(),
};

function cw9Demo(i) {
  if (typeof window === 'undefined' || !window.__cw9DevInject) {
    console.log('open /desk.html first'); return;
  }
  var list = i == null ? CW9_FIXTURE : [CW9_FIXTURE[i]];
  list.forEach(function (m) { window.__cw9DevInject(m); });
}
function cw9DemoXss() { window.__cw9DevInject(CW9_FIXTURE_XSS); }
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CW9_FIXTURE: CW9_FIXTURE, CW9_FIXTURE_XSS: CW9_FIXTURE_XSS };
}
