jest.mock('fs');
jest.mock('pertain');
jest.mock('pkg-dir');
jest.mock('webpack-assets-manifest');
jest.mock('../../Utilities/loadEnvironment');
jest.mock('../plugins/RootComponentsPlugin');
jest.mock('../PWADevServer');

jest.mock('../../BuildBus/declare-base');

const fs = require('fs');
const { SyncHook } = require('tapable');
const declareBase = require('../../BuildBus/declare-base');
const pertain = require('pertain');
const pkgDir = require('pkg-dir');
const WebpackAssetsManifest = require('webpack-assets-manifest');
const RootComponentsPlugin = require('../plugins/RootComponentsPlugin');
const loadEnvironment = require('../../Utilities/loadEnvironment');
const configureWebpack = require('../configureWebpack');

pertain.mockImplementation((_, subject) => [
    {
        name: '@magento/pwa-buildpack',
        path: `./${subject.split('.').pop()}-base`
    }
]);
pkgDir.mockImplementation(x => x);

const specialFeaturesHook = new SyncHook(['special']);
declareBase.mockImplementation(targets => {
    targets.declare({ specialFeatures: specialFeaturesHook });
});

beforeEach(() => {
    pertain.mockClear();
    declareBase.mockClear();
});

const mockStat = (dir, file, err = null) => {
    fs.stat.mockImplementationOnce((_, callback) =>
        callback(err, { isDirectory: () => dir, isFile: () => file })
    );
};

const mockEnv = prod =>
    loadEnvironment.mockReturnValueOnce({
        env: process.env,
        sections: jest.fn(),
        section: jest.fn(
            key =>
                ({
                    devServer: {
                        serviceWorkerEnabled: !!prod
                    }
                }[key])
        ),
        isProd: prod
    });

const simulate = {
    statsAsDirectory() {
        mockStat(true);
        return this;
    },
    statsAsFile() {
        mockStat(false, true);
        return this;
    },
    statsAsMissing() {
        mockStat(false, false, new Error());
        return this;
    },
    productionEnvironment() {
        mockEnv(true);
        return this;
    },
    devEnvironment() {
        mockEnv(false);
        return this;
    }
};

test('throws if app root not provided', async () => {
    await expect(configureWebpack({})).rejects.toThrow('root directory');
});

test('throws if app root not a directory', async () => {
    simulate.statsAsFile();
    await expect(configureWebpack({ context: '.' })).rejects.toThrow(
        'not a directory'
    );
});

test('produces a webpack config and friendly manifest plugin', async () => {
    simulate
        .statsAsDirectory()
        .statsAsFile()
        .productionEnvironment();
    const { clientConfig: config } = await configureWebpack({ context: '.' });
    expect(config).toMatchObject({
        context: '.',
        mode: 'production',
        optimization: expect.any(Object)
    });
    expect(config.entry).toHaveProperty('client');
    expect(config.module).toHaveProperty('rules');
    expect(WebpackAssetsManifest).toHaveBeenCalled();
    const { transform } = WebpackAssetsManifest.mock.calls[0][0];
    const assets = {
        entrypoints: {
            client: {
                js: ['client1.js', 'client2.js']
            }
        },
        'toLoad.js': 'toLoad.compiled.js',
        'RootCmp-FAKE.js': [
            'RootCmp-FAKE-1.compiled.js',
            'RootCmp-FAKE-2.compiled.js'
        ],
        'RootCmp-FAKER.js': 'RootCmp-FAKER-1.compiled.js',
        'image.svg': 'image-hash.svg'
    };
    transform(assets);

    expect(assets.bundles.load).toEqual(['client1.js', 'client2.js']);
    expect(assets.bundles.prefetch).toEqual([
        'RootCmp-FAKE-1.compiled.js',
        'RootCmp-FAKE-2.compiled.js',
        'RootCmp-FAKER-1.compiled.js'
    ]);
    expect(assets.js).toHaveProperty('RootCmp-FAKE');
});

test('works if babel.config.js is not present', async () => {
    simulate
        .statsAsDirectory()
        .statsAsMissing()
        .productionEnvironment();
    await expect(configureWebpack({ context: '.' })).resolves.not.toThrow();
});

test('works in developer mode from cli', async () => {
    simulate
        .statsAsDirectory()
        .statsAsMissing()
        .productionEnvironment();
    const { clientConfig } = await configureWebpack({
        context: '.',
        env: { mode: 'development' }
    });

    expect(clientConfig).toHaveProperty('mode', 'development');
});

test('works in developer mode from fallback', async () => {
    simulate
        .statsAsDirectory()
        .statsAsMissing()
        .devEnvironment();
    const { clientConfig } = await configureWebpack({ context: '.' });

    expect(clientConfig).toHaveProperty('mode', 'development');
});

test('errors when mode unrecognized', async () => {
    simulate
        .statsAsDirectory()
        .statsAsMissing()
        .productionEnvironment();
    await expect(
        configureWebpack({ context: '.', env: { mode: 'wuh' } })
    ).rejects.toThrowError('wuh');
});

test('errors when environment is invalid', async () => {
    simulate.statsAsDirectory().statsAsMissing();
    loadEnvironment.mockReturnValueOnce({
        env: process.env,
        envFilePresent: false,
        error: new Error('Configuration foo was invalid')
    });
    await expect(
        configureWebpack({ context: '.', env: { mode: 'development' } })
    ).rejects.toThrowError('foo was invalid');
});

test('handles special flags', async () => {
    simulate
        .statsAsDirectory()
        .statsAsFile()
        .productionEnvironment();

    const special = {
        jest: {
            esModules: true,
            cssModules: true,
            graphqlQueries: true,
            rootComponents: true,
            upward: true
        },
        'pkg-dir': {
            esModules: true,
            cssModules: true,
            graphqlQueries: true,
            rootComponents: false,
            upward: true
        }
    };

    // Tapable detects the argument length of the tap provided, so we need to
    // declare at least one argument or Tapable won't give us anything.
    const specialFeaturesTap = jest.fn(x => x);
    specialFeaturesHook.tap('configureWebpack.spec.js', specialFeaturesTap);
    const { clientConfig } = await configureWebpack({
        context: '.',
        vendor: ['jest'],
        special
    });
    expect(
        clientConfig.module.rules.find(({ use }) =>
            use.some(({ loader }) => /^graphql\-tag/.test(loader))
        ).include
    ).toHaveLength(3);
    expect(RootComponentsPlugin).toHaveBeenCalled();
    expect(
        RootComponentsPlugin.mock.calls[0][0].rootComponentsDirs.some(entry =>
            entry.includes('jest')
        )
    ).toBeTruthy();
    expect(declareBase).toHaveBeenCalledTimes(1);
    expect(specialFeaturesTap).toHaveBeenCalledWith(special);
});