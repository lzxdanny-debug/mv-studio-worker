const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DownloaderService } = require('../dist/storage/storage.service.js');

test('downloader retries three interrupted streams and atomically publishes the fourth', async () => {
  const expected = Buffer.alloc(4096, 7);
  let attempts = 0;
  const server = http.createServer((_, response) => {
    attempts += 1;
    response.writeHead(200, {
      'content-length': expected.length,
      'content-type': 'application/octet-stream',
    });
    if (attempts <= 3) {
      response.write(expected.subarray(0, 512));
      response.destroy();
      return;
    }
    response.end(expected);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloader-retry-'));
  const destination = path.join(tempDir, 'asset.mp4');

  try {
    await new DownloaderService().download(
      `http://127.0.0.1:${address.port}/asset`,
      destination,
      5_000,
    );
    assert.equal(attempts, 4);
    assert.deepEqual(fs.readFileSync(destination), expected);
    assert.equal(fs.existsSync(`${destination}.part`), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
