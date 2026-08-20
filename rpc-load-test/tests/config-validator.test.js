const { ConfigValidator } = require('../dist/config-validator');

describe('ConfigValidator.resolveMethods', () => {
  test('removes excluded methods from the default method selection', () => {
    const methods = ConfigValidator.resolveMethods([], ['getProgramAccounts']);

    expect(methods).toEqual(
      ConfigValidator.getDefaultMethods().filter(method => method !== 'getProgramAccounts'),
    );
    expect(methods).not.toContain('getProgramAccounts');
  });

  test('applies exclusions to an explicit method selection', () => {
    expect(
      ConfigValidator.resolveMethods(
        ['getSlot', 'getBalance', 'getBlock'],
        ['getBalance'],
      ),
    ).toEqual(['getSlot', 'getBlock']);
  });

  test('rejects an empty method selection after exclusions', () => {
    expect(() => ConfigValidator.resolveMethods(['getSlot'], ['getSlot']))
      .toThrow('Method selection is empty after applying exclusions');
  });
});

describe('ConfigValidator.validate', () => {
  test('stores the exclusion-filtered method list in the runtime config', () => {
    const config = ConfigValidator.validate({
      endpoint: 'https://example.com',
      duration: 1,
      rps: 1,
      concurrent: 1,
      timeout: 1000,
      methods: [],
      methodExclude: ['getProgramAccounts'],
    });

    expect(config.methods).not.toContain('getProgramAccounts');
    expect(config.methods).toEqual(
      ConfigValidator.getDefaultMethods().filter(method => method !== 'getProgramAccounts'),
    );
  });
});
