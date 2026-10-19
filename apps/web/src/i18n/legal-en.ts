export interface LegalSection {
  readonly id: string;
  readonly title: string;
  readonly paragraphs: readonly string[];
}

export interface LegalDocument {
  readonly description: string;
  readonly sections: readonly LegalSection[];
}

export const legalEn = {
  email: "support@neurochess-arena.com",
  updated: "Last updated: October 19, 2026",
  introduction:
    "Neurochess Arena is operated by Illya Katynskyi. These documents apply to the service at neurochess-arena.com.",
  contact: "Questions or requests about your data or these terms:",
  contents: "On this page",
  home: "Return to Neurochess Arena",
  privacy: {
    description:
      "How Neurochess Arena handles account information, private chess games, provider credentials, and Google sign-in data.",
    sections: [
      {
        id: "scope",
        title: "1. About this policy",
        paragraphs: [
          "This policy explains what personal data we handle when you visit Neurochess Arena, sign in, watch AI models play chess, play against an AI, or join a private human game. It also explains your choices and how to contact us about your data.",
          "We use personal data to provide the features you request, maintain accounts and private games, communicate about accounts and support, and protect the service from misuse. We do not sell personal data or use it for advertising. We do not use Google account data to train AI models.",
        ],
      },
      {
        id: "account",
        title: "2. Account and Google sign-in data",
        paragraphs: [
          "For email registration, we store your email address, verification status, a password hash rather than your readable password, and account creation and update records. We also store the username you choose and, if applicable, a profile image URL and your avatar preferences.",
          "Google sign-in requests only openid, email, and profile permissions. Google supplies an account identifier, email address and verification status, and basic profile information, which may include a name and profile image. We retain the Google account identifier to recognize your sign-in, your local email and verification status, and an allowed profile image URL to initialize your optional avatar. We discard the supplied display name; you choose your own username. We do not request Gmail, Drive, Calendar, contacts, or other Google account content.",
          "GitHub sign-in similarly uses your GitHub account identifier, verified email address, and an optional profile image. It does not request access to your private repositories. OAuth access, refresh, and ID tokens are used only as needed to complete sign-in and are not retained in our account records. We never receive your Google or GitHub password.",
          "You can remove an imported avatar in Account settings. When an avatar is displayed, your browser requests the image from Google or GitHub, which receives network information such as your IP address. In a private room, the other participant can see your username and avatar. Your email address and sign-in credentials are not shown to other players.",
        ],
      },
      {
        id: "games",
        title: "3. Games and AI requests",
        paragraphs: [
          "We store game configuration, participants, chess positions and moves, results, model choices and parameters, model commentary, and invocation records such as response timing, token usage, estimated cost, and normalized failures. Registered accounts can retain private game history and their own Stockfish analysis samples. Guest analysis stays in page memory. Stockfish analysis runs in your browser.",
          "Games are private: solo games are available to their owner, and private human games to their authorized participants. An invitation lets its holder request entry into a room; share it only with your intended opponent. A game URL by itself does not grant access. Authorized operators may access stored records when necessary to operate the service, investigate security issues, or respond to a support request.",
          "When you use an AI provider, our server sends the selected provider your current chess position (FEN), complete move history (PGN), side to move, legal moves, standard response instructions, and selected model parameters. We do not send your Google or GitHub profile, email, avatar, account password, or Stockfish analysis as part of the model prompt. Opponent model identity and commentary are excluded.",
          "Supported providers are OpenAI, Anthropic, Google, and OpenRouter. OpenRouter may route a request to an upstream model provider. The provider processes requests under its own terms, privacy policy, and your account settings; its retention or training practices may differ from ours. Choosing Google as an AI provider is separate from using Google to sign in. You can use private human games without sending moves to an AI provider.",
        ],
      },
      {
        id: "credentials",
        title: "4. Your provider API keys",
        paragraphs: [
          "Session-only keys stay in the current page's memory and the backend request scope needed to contact the provider. They are not saved in our database, browser localStorage, or sessionStorage, and are not written to application logs. Refreshing or closing the page clears the page-memory key; leaving the relevant game flow or changing identity also clears it.",
          "If you are signed in and explicitly choose to save a key, our API encrypts it before database storage. The encryption key is kept separately from the database. We retain a provider identifier, your label, masked key metadata, and timestamps so you can manage saved credentials. The server decrypts a saved key only for an authorized provider operation, including model discovery and chess inference, and sends it to that provider for authentication.",
          "You can revoke one saved credential or clear saved credentials in Account settings. This stops future use by Neurochess Arena, but does not revoke the key at the provider or undo a request already sent. You can also revoke or rotate a key in the provider's dashboard.",
        ],
      },
      {
        id: "cookies",
        title: "5. Cookies, connection data, and diagnostics",
        paragraphs: [
          "We use necessary account, guest-session, and sign-in security cookies to authenticate requests and preserve access to private games. Account sessions normally last seven days and may renew with use. Guest access expires after 24 hours without renewal. OAuth state and account verification or reset records are temporary authentication data.",
          "Our authentication system can store an IP address and browser user-agent with a session. Our servers also process IP addresses and request information to deliver the service, prevent abuse, and apply rate limits. Operational diagnostics record bounded error categories, availability, latency, and resource usage. Application logs exclude raw provider keys, passwords, session cookies, authorization headers, and decrypted credentials.",
          "The application uses a non-secret sessionStorage marker to remember that you intended to use an account, preventing an expired sign-in from silently becoming guest play. It does not persist your profile, private games, or raw provider keys in browser storage. We do not include advertising cookies or third-party behavioral analytics in the application. Blocking necessary cookies can prevent sign-in or guest-game recovery.",
        ],
      },
      {
        id: "sharing",
        title: "6. Service providers and international processing",
        paragraphs: [
          "Our hosting and database infrastructure use Oracle Cloud in Frankfurt, Germany. We use Brevo for transactional account email and Cloudflare for domain and DNS services. These providers process the information necessary for their roles, such as stored application data for hosting, recipient addresses and message contents for email delivery, or network information for DNS services. Support correspondence is processed through our support mailbox provider.",
          "Google and GitHub process sign-in requests when you choose those methods. AI providers receive the request data described above only when you use the corresponding AI features. Providers may process data in countries other than yours, according to their service arrangements and privacy policies.",
          "We may disclose information when necessary to comply with a binding legal requirement or protect users and the service against fraud or security threats. We do not give other users access to your saved API keys or private solo games.",
        ],
      },
      {
        id: "retention",
        title: "7. Retention and deletion",
        paragraphs: [
          "We retain account information and private account game history while your account remains in use, unless you delete the relevant data or request deletion. Saved provider keys remain until you revoke them, clear them, or delete the account. You can delete completed or aborted solo games or clear terminal history; unfinished games must first be stopped. Account deletion removes account and sign-in records, sessions, saved credentials, and owned solo games, including unfinished games.",
          "Private human games are shared records. Removing a game from your history removes your access and your saved analysis, while the other participant may keep their copy. Deleting your account removes its identifying bindings from shared games and ends any unfinished room. An anonymized record of moves and results can remain for the other participant. A terminal room is deleted when no participant remains entitled to access it, subject to periodic cleanup for guest participants.",
          "Guest-session expiry ends access; it does not guarantee that stored solo guest game records are immediately deleted. Automatic deletion of expired solo guest records is not currently implemented. Contact us to request deletion and provide the game identifier if available, without sending session cookies or API keys. We may need information that verifies your control of the relevant data. Signing in does not transfer guest games into your account.",
          "Our backup policy sets a seven-day retention period. Deleting live data does not rewrite existing backups, and cloud expiry can take additional time to physically remove an expired backup. Restored data must be reconciled with deletion and credential-revocation requests before public access resumes. Copies already downloaded by you or another participant cannot be recalled. Security and support records may be retained as necessary to resolve a request, prevent abuse, or meet a legal obligation.",
        ],
      },
      {
        id: "choices",
        title: "8. Your choices and privacy requests",
        paragraphs: [
          "Account settings let you update your username, remove your avatar, manage saved credentials, and delete your account. History provides game deletion and PGN export. You can also remove Neurochess Arena's access through your Google or GitHub account settings; this is separate from deleting your Neurochess Arena account and does not itself remove stored games.",
          "Depending on applicable law, you may have rights to access, correct, delete, or receive a copy of your personal data, restrict or object to certain processing, withdraw consent where processing relies on it, and complain to your data protection authority. Contact the support address on this page to exercise these rights or obtain help with data the interface cannot manage. We may verify your identity before disclosing or deleting private information.",
          "Where a legal basis is required, we process data as necessary to provide the service you request, for legitimate interests in securing and maintaining it, to meet legal obligations, or with consent where required. Withdrawing consent does not affect earlier lawful processing. Some features require the data described in this policy to work.",
          "The service is not directed specifically at children. If you believe a child has supplied personal information without the permission required by applicable law, contact us so we can investigate and take appropriate action.",
        ],
      },
      {
        id: "changes",
        title: "9. Policy changes and contact",
        paragraphs: [
          "We will update this page and its date when our practices change. For material changes, we will provide an appropriate notice in the service or by email. If we propose using Google user data for a new purpose, we will provide notice and obtain the consent required before that new use begins.",
          "Contact Illya Katynskyi at the support address below for privacy questions or requests. Do not include passwords, API keys, session cookies, or password-reset links in your message.",
        ],
      },
    ],
  } satisfies LegalDocument,
  terms: {
    description:
      "Terms for using Neurochess Arena, including private chess games, bring-your-own-key AI access, provider charges, and account responsibilities.",
    sections: [
      {
        id: "agreement",
        title: "1. Using the service",
        paragraphs: [
          "These terms govern your use of the hosted Neurochess Arena service operated by Illya Katynskyi. By using the service, you agree to these terms. If you do not agree, do not use it. You must be legally able to enter this agreement or have any permission from a parent or guardian required by applicable law.",
          "Neurochess Arena lets you observe and compare AI models playing chess, play against an AI, and play private online games with another person. It is an experimental service. Features, supported models, and availability can change.",
        ],
      },
      {
        id: "accounts",
        title: "2. Accounts and private access",
        paragraphs: [
          "Keep your sign-in credentials secure and use accurate account information. You are responsible for activity you authorize through your account and provider credentials. Contact us if you believe someone has gained unauthorized access.",
          "Guests can use AI modes and join a private room, but creating a room, retaining account history, and saving provider keys require an account. Guest access depends on the original guest session and is not transferred when you sign in. Share room invitations only with the intended participant. Do not attempt to access another person's private games, account, or credentials.",
        ],
      },
      {
        id: "providers",
        title: "3. Provider charges and your API keys",
        paragraphs: [
          "Neurochess Arena currently has no subscription or service fee. AI use requires your own credentials for a supported provider. That provider may charge your account directly under its prices and terms. Use only credentials you are authorized to use, and review the provider's limits, billing, and data practices before starting a game.",
          "Displayed costs are estimates, may be incomplete, and are not invoices or guaranteed final prices. A provider may charge for unsuccessful, invalid, retried, or interrupted requests. Invalid model output can trigger up to two automatic retries after the first attempt. Pausing, stopping a game, revoking a saved key, or deleting an account cannot undo an upstream request or charge already incurred.",
          "You authorize us to use the key you supply for the provider operations you request, including model discovery, gameplay, and the documented automatic retries. Keys are session-only unless you explicitly choose encrypted saving. You can revoke saved credentials in Account settings and revoke the original key at the provider. Never send keys or passwords to our support mailbox.",
        ],
      },
      {
        id: "conduct",
        title: "4. Acceptable use",
        paragraphs: [
          "Use the service lawfully and respect other users and third-party rights. Do not impersonate another person, submit stolen credentials, bypass authorization or usage limits, exploit vulnerabilities to obtain private data, or disrupt the service with abusive traffic. Do not use usernames or other supplied content to harass others or violate their rights.",
          "Report suspected security issues privately to the support address below. Do not include other users' private data or secrets in a public report. We may restrict access where reasonably necessary to address abuse, security incidents, legal requirements, or serious violations of these terms.",
        ],
      },
      {
        id: "results",
        title: "5. Chess results and AI output",
        paragraphs: [
          "A deterministic chess engine controls legal moves and game results. AI commentary may be inaccurate, misleading, or inappropriate. Stockfish evaluations and model comparisons are informational; they are not guarantees of playing strength or future performance.",
          "Games use the service's published rules, including automatic draws at threefold repetition and 100 half-moves without a pawn move or capture. A third invalid AI response results in a technical loss. Provider, network, authentication, quota, or timeout failures pause the game for your decision to retry. These rules are designed for this service and may differ from tournament procedures.",
        ],
      },
      {
        id: "privacy",
        title: "6. Your data and deletion",
        paragraphs: [
          "Our Privacy Policy explains how we handle account data, games, provider credentials, cookies, and third-party processing. You permit the processing of the information you submit as necessary to provide the requested features, subject to that policy and applicable law. These terms do not transfer ownership of your personal data or grant permission to publish your private games.",
          "You may stop using the service at any time and delete your account through Account settings. Individual completed or aborted games and terminal history can also be removed. Private human games can remain available to another entitled participant; account deletion removes your identifying bindings but may leave an anonymized shared record. Deletion does not recall downloaded copies, immediately rewrite backups, or remove data held independently by an AI or sign-in provider.",
        ],
      },
      {
        id: "license",
        title: "7. Software and third-party rights",
        paragraphs: [
          "The original Neurochess Arena software is licensed under GNU GPL version 3 only. The Licenses and source page provides the license, corresponding source, and third-party notices. These hosted-service terms do not restrict rights granted by that software license or the licenses of third-party components.",
          "Third-party names and trademarks belong to their respective owners. Support for a provider does not imply endorsement or affiliation. The use of third-party services and any rights in their generated output are subject to their applicable terms.",
        ],
      },
      {
        id: "availability",
        title: "8. Availability and responsibility",
        paragraphs: [
          "To the extent permitted by applicable law, the service is provided as available without a guarantee of uninterrupted operation, error-free output, or preservation of every game. Maintenance, outages, provider changes, or security measures can interrupt access. Export important games and use provider spending limits where available.",
          "To the extent permitted by applicable law, the operator is not liable for indirect or consequential loss arising from use of the service, including loss of profits or opportunities. Nothing in these terms excludes liability or limits consumer, privacy, or other rights that cannot lawfully be excluded or limited. Your provider remains responsible for its own billing and services under its agreement with you.",
        ],
      },
      {
        id: "changes",
        title: "9. Changes, questions, and disputes",
        paragraphs: [
          "We may update these terms as the service changes, publishing the revised text and date here. We will provide an appropriate notice for material changes. If you do not accept revised terms, stop using the service; you can export available games and delete your account.",
          "For questions or a dispute concerning the service, contact Illya Katynskyi at the address below so we can try to resolve it. These terms do not remove protections or access to courts and authorities available to you under mandatory applicable law.",
        ],
      },
    ],
  } satisfies LegalDocument,
} as const;
