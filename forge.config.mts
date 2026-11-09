import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import fs from 'node:fs/promises';
import path from 'node:path';

/** What's in python/ only for development, taken back out of the packaged app. */
const PYTHON_DEV_ONLY = [
  '.venv-test',
  '.connector-envs-test',
  'tests',
  'requirements-test.txt',
];

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Extension is picked per platform (icon.ico on Windows).
    icon: 'assets/icon',
    // Copied next to the app: the window and tray icons, and the bundled Python runtime + sidecar
    // (python/runtime is populated by scripts/setup-python.mjs before packaging).
    extraResource: ['assets/icon.png', 'assets/icon.ico', 'python'],
  },
  rebuildConfig: {},
  hooks: {
    // extraResource copies all of python/; the installers are made from what's left here.
    postPackage: async (_config, { outputPaths }) => {
      for (const output of outputPaths) {
        for (const name of PYTHON_DEV_ONLY) {
          await fs.rm(path.join(output, 'resources', 'python', name), {
            recursive: true,
            force: true,
            maxRetries: 5,
          });
        }
      }
    },
  },
  makers: [
    new MakerSquirrel({ setupIcon: 'assets/icon.ico' }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
