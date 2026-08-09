#!/usr/bin/env bun

const args = process.argv.slice(2);
const pathsIndex = args.indexOf("--paths");
const targetDirectory = pathsIndex >= 0 ? args[pathsIndex + 1] : "";

if (!targetDirectory) process.exit(2);

await Bun.write(`${targetDirectory}/Test track [abc123].mp3`, new Uint8Array([0x49, 0x44, 0x33, 0x04]));
