// Tests for how the project's errors are worded and what "Fix with assistant" asks.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  errorLabel,
  errorStage,
  errorSummary,
  fixRequest,
} from '../../src/shared/project-errors.ts';
import type { ProjectError } from '../../src/shared/types.ts';

const source: ProjectError = {
  kind: 'source',
  name: 'Sales DB',
  message: 'Connection refused.',
};

describe('project errors', () => {
  test('each kind has a label, a summary and its workflow step', () => {
    const cases: [ProjectError['kind'], string, string, string][] = [
      ['source', 'Data source', 'Couldn\'t load the data source "x"', 'data'],
      [
        'transform',
        'Transform',
        'The transform of x failed, so it shows its original data',
        'model',
      ],
      [
        'transformed',
        'Transformed table',
        "Couldn't build the table x",
        'model',
      ],
      ['dataset', 'Dataset', "Couldn't update the dataset x", 'visuals'],
    ];
    for (const [kind, label, summary, stage] of cases) {
      const error: ProjectError = { kind, name: 'x', message: 'm' };
      assert.equal(errorLabel(error), label);
      assert.equal(errorSummary(error), summary);
      assert.equal(errorStage(error), stage);
    }
  });

  test('the request says what failed, the error, and asks for a fix', () => {
    assert.equal(
      fixRequest(source),
      'Couldn\'t load the data source "Sales DB". The error was:\n\nConnection refused.\n\nPlease find out why and fix it.',
    );
  });

  test('a long error is cut short in the request', () => {
    const request = fixRequest({ ...source, message: 'x'.repeat(5000) });
    assert.ok(request.length < 2200);
    assert.match(request, /x…\n\nPlease find out why and fix it\.$/);
  });
});
