// Builds Mac (Apple Silicon) and Windows (x64) into ./dist.
// Name, app ID and link scheme come from app/brand.json; version from app/package.json.
import { packager } from '@electron/packager';
import { readFileSync } from 'fs';
const BRAND = JSON.parse(readFileSync('app/brand.json', 'utf8'));
const VERSION = JSON.parse(readFileSync('app/package.json', 'utf8')).version;
// Optional: `node scripts/package.mjs darwin` or `... win32` builds just one platform.
const ONLY = process.argv[2] || '';
const keepKoffi = (dir) => (p) => {
  if (/\.map$/.test(p)) return true;
  if (/^\/node_modules\/koffi\/(src|vendor|doc|lib\/native)(\/|$)/.test(p)) return true;
  const m = /^\/node_modules\/koffi\/build\/koffi\/([^/]+)/.exec(p);
  if (m && m[1] !== dir) return true;
  if (/^\/node_modules\/koffi\/build\/koffi\/[^/]+\/koffi\.(exp|lib)$/.test(p)) return true;
  return false;
};
const common = {
  dir: 'app', out: 'dist', overwrite: true,
  asar: { unpack: '**/koffi.node' },
  appVersion: VERSION, name: BRAND.name, executableName: BRAND.name,
  electronVersion: '38.2.0', prune: false,
  icon: 'build/icons/gameguide', // .icns on Mac, .ico on Windows (A1 Clear G)
};
if (!ONLY || ONLY === 'darwin') await packager({ ...common, platform: 'darwin', arch: 'arm64', ignore: keepKoffi('darwin_arm64'),
  appBundleId: BRAND.appId, appCategoryType: 'public.app-category.games',
  protocols: [{ name: `${BRAND.name} invite`, schemes: [BRAND.id] }],
  extendInfo: {
    NSLocalNetworkUsageDescription: `${BRAND.name} connects directly to your friend's computer on your network.`,
    NSScreenCaptureUsageDescription: `${BRAND.name} shares your game with your friend.`,
  },
});
if (!ONLY || ONLY === 'win32') await packager({ ...common, platform: 'win32', arch: 'x64', ignore: keepKoffi('win32_x64'),
  win32metadata: { CompanyName: BRAND.company, ProductName: BRAND.name, FileDescription: BRAND.name } });
console.log(`done: ${BRAND.name} ${VERSION}`);
