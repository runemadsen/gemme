import { definePlugin } from '@archive/plugin-api';

const TEXT_MIME = /^text\//;
const TEXT_EXT = /\.(txt|md|markdown|csv|json|xml|ya?ml|html?|css|js|ts|log)$/i;

/**
 * Text plugin factory. Extracts full text (for search) plus simple counts from
 * text-like files. Zero dependencies — just reads the bytes as UTF-8.
 *
 * @param {object} [options]
 * @param {number} [options.maxFulltext] - cap on characters pushed into the FTS index
 */
export default function textPlugin(options = {}) {
  const maxFulltext = options.maxFulltext ?? 2 * 1024 * 1024;
  return definePlugin({
    id: 'text',
    matches(mimeType, filename) {
      return (
        TEXT_MIME.test(mimeType || '') ||
        mimeType === 'application/json' ||
        mimeType === 'application/xml' ||
        TEXT_EXT.test(filename || '')
      );
    },
    async extract({ buffer }) {
      const body = buffer.toString('utf8');
      const words = body.split(/\s+/).filter(Boolean).length;
      const lines = body === '' ? 0 : body.split('\n').length;
      return {
        metadata: [
          { key: 'char_count', value: body.length, type: 'number' },
          { key: 'word_count', value: words, type: 'number' },
          { key: 'line_count', value: lines, type: 'number' },
        ],
        fulltext: body.slice(0, maxFulltext),
      };
    },
  });
}
