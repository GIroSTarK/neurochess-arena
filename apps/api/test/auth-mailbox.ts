export interface TestAuthEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export function createTestMailbox() {
  const messages: TestAuthEmail[] = [];
  return {
    messages,
    async send(message: TestAuthEmail) {
      messages.push(message);
    },
    link(index = messages.length - 1) {
      const link = messages[index]?.text.match(/https?:\/\/\S+/)?.[0];
      if (!link) throw new Error("Expected an authentication email link");
      return new URL(link);
    },
  };
}
