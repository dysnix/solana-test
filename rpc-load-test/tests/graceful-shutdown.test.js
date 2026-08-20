const { spawn } = require('child_process');
const path = require('path');

describe('CLI graceful shutdown', () => {
  test.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])('prints captured results after %s', async (signal, expectedExitCode) => {
    const cliPath = path.resolve(__dirname, '../dist/index.js');
    const child = spawn(process.execPath, [
      cliPath,
      '--endpoint', 'http://127.0.0.1:9',
      '--duration', '60',
      '--rps', '10',
      '--concurrent', '1',
      '--timeout', '100',
      '--methods', 'getSlot',
      '--skip-health-check',
    ], {
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let output = '';
    let signalSent = false;
    const capture = chunk => {
      output += chunk.toString();
      if (!signalSent && output.includes('Starting 1 worker threads')) {
        signalSent = true;
        setTimeout(() => child.kill(signal), 100);
      }
    };

    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });

    expect(signalSent).toBe(true);
    expect(exitCode).toBe(expectedExitCode);
    expect(output).toContain('Shutting down gracefully and reporting captured results');
    expect(output).toContain('SOLANA RPC LOAD TEST RESULTS');
    expect(output).toMatch(/Total Requests:\s+[1-9]\d*/);
  }, 10000);
});
