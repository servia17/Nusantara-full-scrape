const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../server.js');

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const { port } = server.address();
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {}
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        if (data) {
          try { parsed = JSON.parse(data); }
          catch { parsed = data; }
        }
        resolve({ statusCode: res.statusCode, body: parsed, headers: res.headers });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('homepage is served over HTTP', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const res = await request(server, 'GET', '/');
    assert.equal(res.statusCode, 200);
    assert.match(String(res.body || ''), /House of Nusantara|Nusantara/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('demo login works without env credentials', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const res = await request(server, 'POST', '/api/auth/login', {
      email: 'admin@example.com',
      password: 'demo123'
    });

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.role, 'admin');
    assert.ok(res.body.token);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
