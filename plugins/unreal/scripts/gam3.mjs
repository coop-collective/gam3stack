#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import * as engine from './engine.mjs';
import { main } from './lib/cli.mjs';

main({ engine, kitsDir: fileURLToPath(new URL('../kits/', import.meta.url)) });
