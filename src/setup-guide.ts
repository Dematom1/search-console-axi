export const setupGuide = [
  { step: 1, instruction: "Enable the Google Search Console API in a Google Cloud project." },
  { step: 2, instruction: "Create a service account; it needs no project-level IAM roles." },
  {
    step: 3,
    instruction: "Load its JSON key from your secret manager into SEARCH_CONSOLE_AXI_SA_KEY. Never commit the key.",
  },
  {
    step: 4,
    instruction:
      "In Search Console, add the service-account email under Settings > Users and permissions with Restricted access.",
  },
  {
    step: 5,
    instruction:
      "For personal access, use your own Desktop OAuth client. Search Console reporting uses https://www.googleapis.com/auth/webmasters.readonly; Indexing API commands use https://www.googleapis.com/auth/indexing, and quota reads use https://www.googleapis.com/auth/cloud-platform. Include the needed scopes with gcloud auth application-default login --client-id-file=client.json --scopes=... .",
  },
];
