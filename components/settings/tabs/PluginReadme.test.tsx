import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PluginReadme } from './PluginReadme';

test('README never creates active HTML, remote media or script links', () => {
  const html = renderToStaticMarkup(<PluginReadme markdown={'# Example\n\n<script>alert(1)</script>\n\n<img src="https://tracker.example/pixel">\n\n![track](https://tracker.example/x.svg)\n\n[run](javascript:alert%281%29)\n\n[docs](https://example.com)\n\n```html\n<iframe src="file:///secret">\n```'} />);
  assert.doesNotMatch(html, /<(script|img|iframe|svg)\b/);
  assert.doesNotMatch(html, /href="(javascript|file):/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /&lt;script&gt;/);
});
