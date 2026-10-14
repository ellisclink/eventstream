/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleNameMapper: {
    // Mirrors the tsconfig path alias so tests import the package the same way services do.
    '^@eventstream/schema$': '<rootDir>/packages/schema/src/index.ts',
    // Source files use NodeNext-style "./x.js" specifiers; resolve them to the .ts sources.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // CDK synthesis in tests is slow on a cold start.
  testTimeout: 30000,
};
