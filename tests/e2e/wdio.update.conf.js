/**
 * Ghostery Browser Extension
 * https://www.ghostery.com/
 *
 * Copyright 2017-present Ghostery GmbH. All rights reserved.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0
 */

import { readFileSync, rmSync, mkdirSync, cpSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { $, expect } from '@wdio/globals';

import { getExtensionElement, waitForIdleBackgroundTasks, PAGE_PORT } from './utils.js';
import * as wdio from './wdio.conf.js';

import { setupTestPage } from './page/server.js';

/**
 * Fork remotes (e.g. p2plabsxyz) may only tag packaging builds like v1.1.0.
 * Update tests must download a real Ghostery upstream zip, so only accept tags
 * that match package.json's major version and otherwise use package.json itself.
 */
function resolveUpdateVersion() {
  if (wdio.argv.version) return String(wdio.argv.version);

  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  const pkgMajor = Number(String(pkg.version).split('.')[0]);

  try {
    execSync('git fetch --tags --quiet', { stdio: 'ignore' });
  } catch {
    // Offline / shallow clone — use whatever tags are already local.
  }

  try {
    const tag = execSync('git tag --sort=-version:refname', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((t) => t.trim())
      .find((t) => {
        const match = /^v(\d+)\.\d+\.\d+$/.exec(t);
        return match && Number(match[1]) === pkgMajor;
      });
    if (tag) return tag.slice(1);
  } catch {
    // Continue to the package.json fallback below.
  }

  // package.json tracks the Ghostery upstream version that has release assets.
  return pkg.version;
}

/*
 * This configuration file is used to update the extension in the browser
 * before running the tests. It uses the original configuration file as a base,
 * and it reuses the same setup and teardown functions.
 */
export const config = {
  ...wdio.config,
  // We include only main features, which can be affected by the extension update. It speed up the tests
  // and avoid long living session issues (especially in Firefox) that can cause false positives in CI
  specs: [wdio.config.specs[0]],
  exclude: [
    // The onboarding spec must be skipped as the extension is already installed and enabled
    './spec/onboarding.spec.js',
  ],
  onPrepare: async (config, capabilities) => {
    if (wdio.argv.clean) {
      rmSync(wdio.WEB_EXT_PATH, { recursive: true, force: true });
      mkdirSync(wdio.WEB_EXT_PATH, { recursive: true });
    } else if (!existsSync(wdio.WEB_EXT_PATH)) {
      mkdirSync(wdio.WEB_EXT_PATH, { recursive: true });
    }

    try {
      const version = resolveUpdateVersion();
      console.log(`Using Ghostery release v${version} as the update-test baseline`);

      for (const capability of capabilities) {
        const url = `https://github.com/ghostery/ghostery-extension/releases/download/v${version}/`;
        const fileName = `ghostery-${capability.browserName === 'chrome' ? 'chromium' : 'firefox'}-${version}.zip`;

        const buildPath = resolve(wdio.WEB_EXT_PATH, fileName);

        // Download build artifacts
        if (!existsSync(buildPath)) {
          console.log(`Downloading Ghostery extension from ${url}${fileName}`);
          execSync(`curl -fL -o ${buildPath} "${url}${fileName}"`);
        }

        switch (capability.browserName) {
          case 'firefox': {
            // Prepare source archive for Firefox
            const sourcePath = `${wdio.FIREFOX_PATH.replace('.zip', '')}-source.zip`;
            if (!existsSync(sourcePath)) {
              wdio.buildForFirefox();

              cpSync(wdio.FIREFOX_PATH, `${wdio.FIREFOX_PATH.replace('.zip', '')}-source.zip`);
            }

            // Use the downloaded build artifact
            cpSync(buildPath, wdio.FIREFOX_PATH);
            break;
          }
          case 'chrome': {
            const sourcePath = `${wdio.CHROME_PATH}-source`;

            // Prepare source folder for Chrome
            if (!existsSync(sourcePath)) {
              wdio.buildForChrome();
              cpSync(wdio.CHROME_PATH, sourcePath, { recursive: true });
            }

            // Use the downloaded build artifact
            rmSync(wdio.CHROME_PATH, { recursive: true, force: true });
            execSync(`unzip ${buildPath} -d ${wdio.CHROME_PATH}`);
            break;
          }
        }
      }

      setupTestPage(PAGE_PORT);
    } catch (e) {
      console.error('Error while preparing test environment', e);
      process.exit(1);
    }
  },
  before: async (capabilities, specs, browser) => {
    await wdio.config.before(capabilities, specs, browser);

    try {
      // Enable the extension
      await browser.url('ghostery:onboarding');
      await getExtensionElement('button:enable').click();

      // Reload extension with the source
      switch (capabilities.browserName) {
        case 'firefox': {
          // Clean up replaced original path
          rmSync(wdio.FIREFOX_PATH, { force: true });

          // Replace extension files with the source
          const extension = readFileSync(`${wdio.FIREFOX_PATH.replace('.zip', '')}-source.zip`);
          // Must await: otherwise the previous temporary add-on can keep its
          // webRequest listeners alive (e.g. Sec-GPC) beside the new build.
          await browser.installAddOn(extension.toString('base64'), true);

          await browser.url('about:debugging#/runtime/this-firefox');

          await expect($('.extension-backgroundscript__status')).toHaveElementClass(
            expect.stringContaining('extension-backgroundscript__status--running'),
          );

          break;
        }
        case 'chrome': {
          // Replace and remove extension files with the source
          renameSync(wdio.CHROME_PATH, `${wdio.CHROME_PATH}-old`);
          cpSync(`${wdio.CHROME_PATH}-source`, wdio.CHROME_PATH, {
            recursive: true,
          });
          rmSync(`${wdio.CHROME_PATH}-old`, { recursive: true, force: true });

          // Reload the extension in the browser
          await browser.url('chrome://extensions');
          await $('>>>#dev-reload-button').click();

          break;
        }
      }

      await browser.pause(5000);

      await browser.url('ghostery:settings');
      await expect(getExtensionElement('page:settings')).toBeDisplayed();
      await waitForIdleBackgroundTasks();

      console.log('Extension updated...');
    } catch (e) {
      console.error('Error while updating extension', e);

      // close the browser session
      await browser.deleteSession();

      // send a signal to the parent process to stop the tests
      process.kill(process.pid, 'SIGTERM');
    }
  },
};
