import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import fixture from '../../../agentcore/test/fixtures/native-created-workflow-2.11.1.json' with { type: 'json' };

// Actual pinned-package artifacts establish creation only. The enclosing test
// explicitly controls when creation follows its inert published intake offer.
export const writeCreatedWorkflow = async (project) => {
  for (const [path, content] of Object.entries(fixture.files)) {
    const destination = join(project, path);
    await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, content, { mode: 0o600 });
  }
};
