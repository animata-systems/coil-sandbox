/**
 * Unit tests for detectProseMentions.
 *
 * Covers the lexical rules from spec §9.4a: identifier form, boundaries,
 * inline and fenced code-span escape, Unicode support, edge cases.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProseMentions } from './protocol-runner.js';

test('bare prose-mention is detected', () => {
  assert.deepEqual(detectProseMentions('@zombie, проверь'), ['zombie']);
});

test('mention surrounded by whitespace', () => {
  assert.deepEqual(detectProseMentions('hello @world hi'), ['world']);
});

test('mention at start of body', () => {
  assert.deepEqual(detectProseMentions('@start is here'), ['start']);
});

test('mention at end of body', () => {
  assert.deepEqual(detectProseMentions('trailing @end'), ['end']);
});

test('inline single-backtick escapes mention', () => {
  assert.deepEqual(detectProseMentions('цитата: `@config` ок'), []);
});

test('inline double-backtick escapes mention', () => {
  assert.deepEqual(detectProseMentions('see ``@config`` example'), []);
});

test('mixed: prose-mention outside, escape inside same line', () => {
  assert.deepEqual(
    detectProseMentions('ping @zombie — цитата `@config` не считается'),
    ['zombie'],
  );
});

test('fenced code block (no language tag) escapes mentions', () => {
  const text = ['Пример:', '```', '@tester внутри', '@other тоже', '```', 'после'].join('\n');
  assert.deepEqual(detectProseMentions(text), []);
});

test('fenced code block with language tag escapes mentions', () => {
  const text = ['before', '```coil', '@tester', '```', 'after'].join('\n');
  assert.deepEqual(detectProseMentions(text), []);
});

test('fenced block does not swallow mentions outside', () => {
  const text = ['@before', '```', '@inside', '```', '@after'].join('\n');
  assert.deepEqual(detectProseMentions(text), ['before', 'after']);
});

test('unclosed fenced block leaves content as literal prose', () => {
  // Per spec §9.4a: unclosed fence is not a code-span; @X is recognized.
  const text = ['```', '@X'].join('\n');
  assert.deepEqual(detectProseMentions(text), ['X']);
});

test('unclosed inline backtick leaves @X as literal', () => {
  assert.deepEqual(detectProseMentions('вот `@X без закрытия'), ['X']);
});

test('email-like pattern is not a mention', () => {
  assert.deepEqual(detectProseMentions('пиши на user@host.com'), []);
});

test('in-word @ is not a mention', () => {
  assert.deepEqual(detectProseMentions('abc@def'), []);
});

test('Unicode identifier (Cyrillic) is detected', () => {
  assert.deepEqual(detectProseMentions('Привет, @иван'), ['иван']);
});

test('mixed scripts identifier', () => {
  // Identifier rules allow letters from any script + digits + underscore.
  assert.deepEqual(detectProseMentions('meet @иван_42'), ['иван_42']);
});

test('multiple mentions separated by punctuation', () => {
  assert.deepEqual(detectProseMentions('ping @X, @Y и @Z.'), ['X', 'Y', 'Z']);
});

test('preserves order of occurrence', () => {
  assert.deepEqual(detectProseMentions('@c, @a, @b'), ['c', 'a', 'b']);
});

test('multiline body', () => {
  const text = ['First line @a', 'Second @b', 'Third @c'].join('\n');
  assert.deepEqual(detectProseMentions(text), ['a', 'b', 'c']);
});

test('@all is returned as plain token (expansion is caller responsibility)', () => {
  assert.deepEqual(detectProseMentions('всем @all в бой'), ['all']);
});

test('dynamic form @$obj is not recognized', () => {
  // Per §9.4a: dynamic addressing belongs to COIL syntax zone, not message body.
  assert.deepEqual(detectProseMentions('@$маршрут.ответственный'), []);
});

test('identifier starting with digit is not a mention', () => {
  // Per §1.2: identifier cannot start with a digit.
  assert.deepEqual(detectProseMentions('see @42bugs'), []);
});

test('identifier with underscore lead is not recognized', () => {
  // Per §1.2 and regex: identifier must lead with a letter.
  // Note: COIL allows `_` in identifiers but the regex requires a letter at start.
  assert.deepEqual(detectProseMentions('@_private'), []);
});

test('deduplication is NOT performed here (duplicates returned)', () => {
  // Dedup and @all-expansion are applied upstream in spawnMentionedProtocols.
  assert.deepEqual(detectProseMentions('@X and @X again'), ['X', 'X']);
});

test('CRLF line endings handled', () => {
  const text = '@a\r\n```\r\n@b\r\n```\r\n@c';
  assert.deepEqual(detectProseMentions(text), ['a', 'c']);
});

test('empty body', () => {
  assert.deepEqual(detectProseMentions(''), []);
});

test('only code-span content', () => {
  assert.deepEqual(detectProseMentions('`@only`'), []);
});

test('punctuation around mention: brackets, quotes, em-dash', () => {
  assert.deepEqual(detectProseMentions('(@a), "@b", @c—@d'), ['a', 'b', 'c', 'd']);
});

test('lone @ symbol is not a mention', () => {
  assert.deepEqual(detectProseMentions('email @ sign alone'), []);
});

test('backtick adjacent to mention on outside does not mask it', () => {
  // `code`@name — name is outside the span.
  assert.deepEqual(detectProseMentions('`code`@name'), ['name']);
});
