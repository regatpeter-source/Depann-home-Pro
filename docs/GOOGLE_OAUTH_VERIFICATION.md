# Google OAuth verification package

This is the reviewer-ready submission package for the production application **Depann'Home Pro**, available at `https://depannhomepro.com`.

## Exact scopes requested

The OAuth consent screen, Google Auth Platform **Data Access** page, authorization request, justification form, and demonstration video must all show exactly:

- `openid`
- `email`
- `profile`
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.send`

Do not add `https://mail.google.com/`, `gmail.modify`, `gmail.compose`, or another Gmail scope.

## Scope justifications to paste into Google Cloud

### `https://www.googleapis.com/auth/gmail.readonly`

Depann'Home Pro is field-service management software used by repair companies. Partner organizations send work orders by email. After a company administrator voluntarily connects the company's Google Workspace mailbox, Depann'Home Pro uses `gmail.readonly` to show that mailbox's inbox inside the prominent “Espace e-mail de l’entreprise” interface; list messages within a user-selected date range; open a selected message; read its sender, recipients, subject, body, thread identifiers, and compatible attachments; and let the user import the selected email into a partner mission and customer record. Reading the complete message and attachments is essential because work-order details such as the customer, service address, claim reference, requested work, and supporting PDF may appear in either the body or an attachment.

No narrower Gmail scope can provide this feature. `gmail.metadata` cannot access message bodies or attachments, so it cannot display the email content or extract the operational information required to create the mission. `gmail.send` provides no read access. Depann'Home Pro does not request `gmail.modify` or `https://mail.google.com/` because it never changes labels, moves, deletes, trashes, or marks messages as read. Ordinary messages viewed in the live inbox remain at Google and are not permanently copied; only a message explicitly imported as a business mission and its selected documents are retained in the user's business record.

### `https://www.googleapis.com/auth/gmail.send`

Depann'Home Pro uses `gmail.send` only to send an email that an authorized user explicitly writes and submits from the visible “Répondre dans le fil d’origine” form, or a mission-status update that the company administrator has explicitly enabled. The message is sent from the voluntarily connected Google Workspace mailbox to the sender of the source work order, preserves the Gmail conversation thread when available, and appears in that source mailbox's Gmail Sent folder. This lets the company acknowledge a work order, answer the partner, send selected business documents, and communicate mission progress without leaving the mission workspace.

No narrower scope can implement this feature: identity scopes and `gmail.readonly` cannot send mail. `gmail.compose` is not sufficient because the application must transmit the user-approved reply directly rather than merely create a draft that requires a separate Gmail workflow. Depann'Home Pro requests only `gmail.send`, not `gmail.modify` or `https://mail.google.com/`, because it does not need to edit drafts, labels, messages, or mailbox state.

## Google Cloud Console checklist

1. Select the production project whose OAuth client ID is deployed as `GOOGLE_MAIL_CLIENT_ID`.
2. Confirm that **Gmail API** is enabled under **APIs & Services → Enabled APIs & services**.
3. Under **Google Auth Platform → Branding**, use the exact production name **Depann'Home Pro**, verified domain `depannhomepro.com`, a monitored support email, homepage `https://depannhomepro.com`, and privacy policy `https://depannhomepro.com/confidentialite`.
4. Confirm ownership of `depannhomepro.com` in Google Search Console using a Google Cloud project owner or editor.
5. Under **Data Access**, keep exactly the five scopes above. Remove stale scopes from Data Access and the verification request.
6. Under **Clients**, use a **Web application** client with exact redirect URI `https://depannhomepro.com/api/partner-email/oauth/google/callback`. Remove obsolete non-production or non-HTTPS URLs.
7. Under **Audience**, publish the app to **Production** and verify that the user type matches the real audience.
8. Confirm that project owners, editors, and essential contacts are current and monitor review emails.
9. Verify that the production privacy policy and its Limited Use disclosure are public without authentication.
10. Record a new uncut demonstration after Console changes. Set the consent-screen language to **English** and expand the complete permission list.
11. Upload the video as an unlisted reviewer-accessible link requiring no sign-in or access request.
12. Submit the two justifications, video URL, active test credentials, and navigation instructions below.

## Demonstration video script

Use a dedicated test company and test Google Workspace mailbox containing synthetic data only. Keep the browser URL visible and do not edit out loading, consent, or results.

1. Open `https://depannhomepro.com` signed out. Show the product homepage, app name, logo, functionality description, and privacy-policy footer link.
2. Open `https://depannhomepro.com/confidentialite`. Show section **3. Utilisation des données Google et des boîtes de messagerie**, including both exact Gmail scopes, purposes, retention, revocation, and Limited Use disclosure.
3. Sign in with the supplied Depann'Home Pro reviewer account on its authorized Admin workstation.
4. Navigate to **Paramètres → Entreprise · Boîte mail**. Show the notice above the OAuth controls: Gmail messages and attachments are read to display and create missions, replies are sent only when requested, Gmail is not modified, and access can be revoked.
5. Select **Sélection manuelle**, leave automatic search disabled, and click **Connecter Google Workspace**.
6. Show Google's account chooser and consent screens with the production app name and branding. Set the language to **English**, expand the complete access list, and clearly show permission to read Gmail messages and attachments and permission to send email. Complete affirmative consent with the supplied Google Workspace source account.
7. Return to Depann'Home Pro and show the exact connected Gmail address as verified.
8. Open **Espace e-mail de l’entreprise**, select dates containing the synthetic work order, and click **Rechercher les missions**. Show its sender, subject, excerpt, score, reasons, and attachment count. Explain that this visible action uses `gmail.readonly`.
9. Click **Consulter les e-mails**, open the same work order, and show its sender, recipients, subject, body, and attachment. Download the synthetic attachment. Explain why `gmail.metadata` cannot provide bodies or attachments. Show that its read/unread state remains unchanged.
10. Click **Envoyer ce mail dans Missions partenaires** and show success. Open **Missions partenaires → Boîte mail professionnelle**, then show the created mission and customer details populated from the synthetic email or document.
11. Return to the email, type a unique reply in **Répondre dans le fil d’origine**, and click **Envoyer la réponse**. Show success. Explain that this explicit action uses `gmail.send`; no background reply is sent unless status updates are separately enabled.
12. Open `mail.google.com` for the same connected Google Workspace source account. In **Sent**, show the unique reply, recipient, content, timestamp, and conversation thread. This proves the source-account impact of `gmail.send`.
13. Return to Depann'Home Pro, click **Déconnecter**, confirm, and show that the mailbox disappears. Open Google Account **Third-party connections** and show where access can be revoked.

## Test credentials and reviewer navigation

Provide credentials through Google's secure verification form or direct reviewer correspondence, never in source control, this document, a video description, or public ticket.

Provide:

- a production Depann'Home Pro account with role **Admin**;
- first-login and workstation activation already completed;
- a dedicated Google Workspace account able to grant the scopes;
- synthetic inbox emails and supported attachments covering the demonstrated dates;
- recovery or MFA instructions that do not depend on an unavailable person;
- credential validity for the entire review period.

Paste these instructions after replacing every bracketed placeholder:

> Open https://depannhomepro.com/connexion and sign in with the Depann'Home Pro credentials supplied in the secure credentials fields. The account is already activated as an Admin workstation. In the left navigation, open “Paramètres”, select “Entreprise”, then scroll to “Boîte mail professionnelle”. Keep “Sélection manuelle” selected and click “Connecter Google Workspace”. Authorize the dedicated Google Workspace test account supplied in the secure credentials fields. After connection, open “Espace e-mail de l’entreprise”. Select [START DATE] through [END DATE] and click “Rechercher les missions”. Click “Consulter les e-mails”, open “[TEST SUBJECT]”, and use “Télécharger” for its attachment. Click “Envoyer ce mail dans Missions partenaires” to create the mission. To test sending, enter a reply under “Répondre dans le fil d’origine” and click “Envoyer la réponse”; then open Gmail for the same source account and verify the message in Sent. No payment, invitation, or additional setup is required.

Rehearse all steps with a clean browser profile. If a reviewer cannot complete a step without assistance, the package is not ready.

## Reviewer response template

> Hello Google OAuth Verification Team,
>
> Thank you for the feedback. We updated our submission so that the scopes configured in Google Auth Platform, requested by the production OAuth endpoint, justified in the form, and shown in the new demonstration video match exactly: `openid`, `email`, `profile`, `https://www.googleapis.com/auth/gmail.readonly`, and `https://www.googleapis.com/auth/gmail.send`.
>
> The new uncut video shows the complete OAuth grant in English, the full permission list, the connected source mailbox, date-range search, message body and attachment access, mission import, an explicit reply sent from Depann'Home Pro, and that reply in the connected Gmail account's Sent folder. We also supplied active test credentials and exact navigation instructions.
>
> `gmail.readonly` is required because the user-facing mission workflow must read message bodies and attachments; `gmail.metadata` cannot provide that content. `gmail.send` is required to transmit the reply explicitly submitted by the user; read-only and identity scopes cannot send, while `gmail.compose` would only create a draft and would not complete the requested in-app send action. The application does not request or use `gmail.modify` or `https://mail.google.com/` and never changes labels, moves, deletes, trashes, or marks Gmail messages as read.
>
> Privacy policy: https://depannhomepro.com/confidentialite
>
> Demo video: [REVIEWER-ACCESSIBLE VIDEO URL]
>
> Please let us know if any further evidence is required.