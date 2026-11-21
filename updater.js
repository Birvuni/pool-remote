// Self-update from the app: check GitHub (the repo's own "origin") for a newer version and,
// on request, fast-forward to it and restart. Under pm2 the process is restarted automatically.
//
// Only a clean fast-forward of the current branch is allowed: no local edits are overwritten,
// nothing is merged, and only the repository this was cloned from is used.

const { execFile } = require('child_process');
const path = require('path');

const DIR = __dirname;
const CHECK_TTL_MS = 10 * 60 * 1000;
let cache = null; // { at, result }
let busy = false;

function git(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: DIR, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().trim().split('\n').pop()));
      resolve(String(stdout));
    });
  });
}

const currentVersion = () => {
  delete require.cache[require.resolve(path.join(DIR, 'package.json'))];
  return require(path.join(DIR, 'package.json')).version;
};

// Changelog sections newer than the running version.
function notesSince(changelog, version) {
  const out = [];
  let take = false;
  for (const line of changelog.split('\n')) {
    const m = /^## (\d+\.\d+\.\d+)/.exec(line);
    if (m) {
      if (m[1] === version) break;
      take = true;
    }
    if (take) out.push(line);
  }
  return out.join('\n').trim();
}

async function check(force = false) {
  if (!force && cache && Date.now() - cache.at < CHECK_TTL_MS) return cache.result;
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  await git(['fetch', '--quiet', 'origin', branch], 60000);
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  const remote = (await git(['rev-parse', `origin/${branch}`])).trim();
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).trim() !== '';
  let canFastForward = false;
  try { await git(['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`]); canFastForward = true; } catch { /* diverged */ }
  const current = currentVersion();
  let latest = current, notes = '';
  if (head !== remote) {
    try { latest = JSON.parse(await git(['show', `origin/${branch}:package.json`])).version; } catch { /* keep current */ }
    try { notes = notesSince(await git(['show', `origin/${branch}:CHANGELOG.md`]), current); } catch { /* no changelog */ }
  }
  const result = {
    current, latest, branch,
    commit: head.slice(0, 7), latestCommit: remote.slice(0, 7),
    available: head !== remote && canFastForward,
    blockedReason: head === remote ? null : dirty ? 'The Pi has local changes to Pool Remote files, so it won\'t update automatically.'
      : !canFastForward ? 'The Pi\'s copy has diverged from GitHub, so it won\'t update automatically.' : null,
    notes,
    checkedAt: new Date().toISOString(),
  };
  if (dirty && result.available) result.available = false;
  cache = { at: Date.now(), result };
  return result;
}

// Fast-forward to the latest version, then exit so pm2 restarts the new code.
async function apply(onDone) {
  if (busy) throw new Error('An update is already running');
  busy = true;
  try {
    const c = await check(true);
    if (!c.available) throw new Error(c.blockedReason || 'Already up to date');
    await git(['merge', '--ff-only', `origin/${c.branch}`], 60000);
    cache = null;
    const version = currentVersion();
    onDone({ ok: true, from: c.current, to: version });
    setTimeout(() => process.exit(0), 800); // pm2 restarts the process with the new code
  } finally {
    busy = false;
  }
}

module.exports = { check, apply, _test: { notesSince } };
