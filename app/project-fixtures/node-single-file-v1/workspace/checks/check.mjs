export const contract = Object.freeze({
  id: 'greet-name-contract-v1',
  exportName: 'greetName',
  resultType: 'string',
  cases: Object.freeze([
    Object.freeze({ id: 'english-name', input: '  Ada  ', expected: 'Hello, Ada!' }),
    Object.freeze({ id: 'han-name', input: ' 小理 ', expected: 'Hello, 小理!' }),
    Object.freeze({ id: 'empty-name', input: '   ', expected: 'Hello, friend!' }),
  ]),
});
