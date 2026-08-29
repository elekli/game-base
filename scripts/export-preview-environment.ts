import { previewRuntimeEnvironment } from "../tests/fixtures/preview-runtime-environment";

for (const [name, value] of Object.entries(previewRuntimeEnvironment)) {
  if (value.includes("\n")) throw new Error(`Invalid fixture value for ${name}.`);
  console.log(`${name}=${value}`);
}
