/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/*.test.ts', '**/*.spec.ts'],
    modulePathIgnorePatterns: ['<rootDir>/dist/']
};
