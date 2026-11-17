'use strict';
/**
 * 1.25: the app's name on this server. A server set up with the installer for another customer can have
 * its own name (setting 'app_name', written by the installer); the web app, the iPhone profile, the intro
 * page and the admin panel then show it instead of «سپن». Read when the server starts.
 */
const { getSetting } = require('./db');

const DEFAULT = 'سپن';
const clean = (s) => String(s || '').replace(/[\u0000-\u001f<>&"'`\\]/g, '').trim().slice(0, 30);
const appName = () => clean(getSetting('app_name', '')) || DEFAULT;

/** Text with «سپن» replaced by this server's app name (a Buffer stays a Buffer). */
function brand(body) {
  const name = appName();
  if (name === DEFAULT) return body;
  const isBuf = Buffer.isBuffer(body);
  const out = (isBuf ? body.toString('utf8') : String(body)).split(DEFAULT).join(name);
  return isBuf ? Buffer.from(out) : out;
}

module.exports = { appName, brand, DEFAULT };
