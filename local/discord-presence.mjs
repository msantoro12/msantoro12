// Sets YOUR Discord Rich Presence from the nightly digest.
//
// RUNS ON YOUR MACHINE, not in CI. That is not a preference, it is the only way
// this works: Discord exposes Rich Presence over a local IPC socket that the
// desktop client opens (\\?\pipe\discord-ipc-0 on Windows). There is no cloud
// endpoint. A GitHub runner has nothing at the other end of that pipe.
//
// It is also the only SANCTIONED way to put automated text under your own name.
// Setting the custom-status field instead needs your user token against an
// undocumented endpoint -- that is a self-bot, it violates Discord's terms, and
// the account it would risk is the one you are about to introduce yourself with.
//
// What you get, under your own name in the member list and on your profile card:
//
//     Good Stuff Software
//     92 commits today
//     Building software that earns trust
//
// What you do not get: it only shows while the Discord DESKTOP client is running
// on this machine. Close Discord and the presence goes with it. The presence also
// only persists while THIS process stays connected, which is why it is a small
// daemon rather than a cron job.
//
// SETUP
//   1. https://discord.com/developers/applications -> New Application.
//      Name it what you want shown on the top line ("Good Stuff Software").
//      Copy the Application ID into DISCORD_APP_ID below. It is not a secret --
//      client IDs are public by design -- so it is fine in this repo.
//   2. Rich Presence -> Art Assets -> upload a 512x512 image keyed `logo` if you
//      want an icon. Optional; the code degrades without it.
//   3. node local/discord-presence.mjs
//   4. To start it at logon, point a shortcut in shell:startup at it, the same
//      way the deckhand listener is launched.

import net from 'node:net';
import os from 'node:os';

const DISCORD_APP_ID = process.env.DISCORD_APP_ID ?? 'PUT_YOUR_APPLICATION_ID_HERE';
const DIGEST_URL =
  process.env.DIGEST_URL ??
  'https://raw.githubusercontent.com/msantoro12/msantoro12/main/digest.json';
const REFRESH_MS = Number(process.env.REFRESH_MS ?? 15 * 60 * 1000);

if (!/^\d{17,20}$/.test(DISCORD_APP_ID)) {
  console.error('Set DISCORD_APP_ID (or edit the constant) to your Discord Application ID.');
  process.exit(1);
}

// --- IPC transport -----------------------------------------------------------
// Frames are: 4-byte LE opcode, 4-byte LE payload length, then UTF-8 JSON.
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;

const pipePath = (i) =>
  process.platform === 'win32'
    ? `\\\\?\\pipe\\discord-ipc-${i}`
    : `${process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? os.tmpdir()}/discord-ipc-${i}`;

function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

// Discord listens on the first free socket of ten, so which one is in use depends
// on how many clients have been opened. Try them in order rather than assuming 0.
function connect() {
  return new Promise((resolve, reject) => {
    let i = 0;
    const attempt = () => {
      if (i > 9) return reject(new Error('No Discord IPC socket found. Is the desktop app running?'));
      const sock = net.createConnection(pipePath(i));
      sock.once('connect', () => resolve(sock));
      sock.once('error', () => {
        sock.destroy();
        i += 1;
        attempt();
      });
    };
    attempt();
  });
}

async function fetchDigest() {
  const res = await fetch(DIGEST_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`digest ${res.status}`);
  return res.json();
}

// --- presence ----------------------------------------------------------------

let sock = null;
const startedAt = Date.now();

function setActivity(digest) {
  if (!sock) return;
  sock.write(
    encode(OP_FRAME, {
      cmd: 'SET_ACTIVITY',
      nonce: String(Date.now()),
      args: {
        pid: process.pid,
        activity: {
          // `details` is the bold line, `state` the one under it.
          details: digest.headline,
          state: 'Building software that earns trust',
          timestamps: { start: startedAt },
          assets: { large_image: 'logo', large_text: 'Good Stuff Software' },
        },
      },
    }),
  );
}

async function tick() {
  try {
    const digest = await fetchDigest();
    setActivity(digest);
    console.log(`[${new Date().toISOString()}] presence -> ${digest.headline}`);
  } catch (err) {
    // A failed refresh leaves the LAST good presence up rather than blanking it.
    // Stale beats empty: an empty presence reads as "not working", which is a
    // worse lie than a few hours out of date.
    console.warn(`refresh failed, keeping last presence: ${err.message}`);
  }
}

async function run() {
  sock = await connect();

  sock.on('close', () => {
    console.warn('Discord closed the socket. Reconnecting in 30s.');
    sock = null;
    setTimeout(() => run().catch((e) => console.error(e.message)), 30_000);
  });
  sock.on('error', (e) => console.warn(`socket error: ${e.message}`));

  // The handshake must land before any frame, so wait for READY rather than
  // firing SET_ACTIVITY straight after connect.
  sock.once('data', async () => {
    await tick();
    setInterval(tick, REFRESH_MS);
  });

  sock.write(encode(OP_HANDSHAKE, { v: 1, client_id: DISCORD_APP_ID }));
}

process.on('SIGINT', () => {
  sock?.destroy();
  process.exit(0);
});

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
