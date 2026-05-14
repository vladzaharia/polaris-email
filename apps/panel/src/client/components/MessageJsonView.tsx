// MessageJsonView — placeholder for the rich message inspector. Phase I will
// add MIME-part navigation, attachment download links, and DKIM/SPF result
// chips.
import { CodeBlock } from './CodeBlock.js';

export function MessageJsonView({ message }: { message: unknown }) {
  return <CodeBlock code={JSON.stringify(message, null, 2)} language="json" />;
}
