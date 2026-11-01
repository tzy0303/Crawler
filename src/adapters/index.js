import beclass from './beclass.js';
import { createGenericAdapter } from './generic.js';
import { createMail104Adapter } from './mail104.js';
import { readSitesFile } from '../core/sites-file.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 內建（寫程式的）來源；設定在 config.json 的 sites */
export const builtinAdapters = { [beclass.id]: beclass };
const builtinFactories = { mail104: () => createMail104Adapter(process.env, { mailDir: join(ROOT_DIR, process.env.MAIL_DIR || 'mail') }) };

/**
 * 所有網站：內建 + 網頁新增的（sites.json）
 * @returns {{ adapter, enabled, maxPages, initialPages, custom, config?, options }[]}
 */
export function loadSites(config) {
  const builtins = [...Object.values(builtinAdapters), ...Object.values(builtinFactories).map((f) => f())];
  const sites = builtins.map((adapter) => {
    const c = config.sites[adapter.id] ?? {};
    return {
      adapter,
      custom: false,
      // configured === false：例如通知信還沒設定信箱帳密，不排程
      enabled: !!c.enabled && adapter.configured !== false,
      maxPages: c.maxPages ?? 30,
      initialPages: c.initialPages ?? 20,
      options: { sinceDays: c.sinceDays, initialDays: c.initialDays },
    };
  });
  const reserved = new Set(builtins.map((a) => a.id));
  for (const cfg of readSitesFile(config.sitesFile)) {
    if (!cfg?.id || reserved.has(cfg.id)) continue;
    try {
      sites.push({
        adapter: createGenericAdapter(cfg),
        custom: true,
        config: cfg,
        enabled: cfg.enabled !== false,
        maxPages: cfg.maxPages ?? 5,
        initialPages: cfg.initialPages ?? cfg.maxPages ?? 5,
        options: {},
      });
    } catch (err) {
      console.error(`網站設定 ${cfg.id} 有誤：${err.message}`);
    }
  }
  return sites;
}
