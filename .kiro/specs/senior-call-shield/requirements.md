# Requirements Document

## Introduction

Senior Call Shield is a SaaS application that protects senior citizens from spam and fraud phone calls while giving their family members oversight. A family member (the caregiver) provisions a SignalWire phone number that forwards to the senior's existing phone number. Incoming calls are screened: calls from saved (known) contacts connect directly to the senior, while calls from unknown numbers are evaluated for spam and fraud risk, optionally handled by an AI screening agent, and summarized in AI-generated reports. Both the caregiver and the senior have dashboards showing the information relevant to their role. One caregiver may manage one or more seniors, and setup requires a documented consent step from the senior.

This document defines the requirements for the feature. It builds on the existing stack (Next.js App Router, React, TypeScript, Better Auth, Prisma with PostgreSQL, shadcn/ui, Tailwind CSS) and uses SignalWire for telephony (number provisioning, call handling via SWML, and AI call screening). The product is marketed under the working name Mabel.

## Glossary

- **System**: The Senior Call Shield application as a whole, including web application, database, and telephony integration.
- **Caregiver**: A family member who provisions and manages call protection on behalf of one or more Seniors. A role assigned to an authenticated account.
- **Senior**: A protected individual whose existing phone receives forwarded calls after screening. A role assigned to an authenticated account.
- **Care_Link**: The association between one Caregiver and one Senior that grants the Caregiver management authority over that Senior's protection settings.
- **Protection_Number**: A SignalWire phone number provisioned by the System that receives inbound calls and forwards connected calls to the Senior's existing phone number.
- **Personal_Number**: The Senior's existing phone number to which connected calls are forwarded.
- **Caller**: The originating party of an inbound call to a Protection_Number, identified by a Caller_Number.
- **Caller_Number**: The telephone number of the Caller as presented on the inbound call.
- **Known_Contact**: A Caller_Number saved to a Senior's allowlist that bypasses screening and connects directly to the Senior.
- **Unknown_Caller**: A Caller whose Caller_Number is not a Known_Contact for the called Senior.
- **Screening_Agent**: The SignalWire AI agent that answers and interacts with an Unknown_Caller to gather call intent before deciding whether to connect.
- **Risk_Assessment**: A classification produced by the System for an inbound call, with a category of Known, Allowed, Spam, or Fraud, and a numeric risk score.
- **Call_Record**: A stored record of a single inbound call, including Caller_Number, timestamp, screening outcome, Risk_Assessment, and disposition.
- **Call_Report**: An AI-generated natural-language summary of an Unknown_Caller interaction, derived from the Screening_Agent transcript and the Risk_Assessment.
- **Caregiver_Dashboard**: The web interface presenting Call_Records, Call_Reports, and management controls to a Caregiver.
- **Senior_Dashboard**: The web interface presenting the Senior's own call activity and contacts to a Senior.
- **Consent_Record**: A stored record that the Senior has agreed to call forwarding and screening for a given Protection_Number.
- **SignalWire**: The third-party telephony platform used for number provisioning and call handling.
- **Family_Plan**: A recurring monthly subscription a Caregiver pays per Senior for call protection, priced between $14.99 and $19.99 per Senior per month.
- **Partner**: An organization (for example a care agency or reseller) that enrolls members and is billed a recurring per-member monthly fee.
- **Subscription**: A recurring billing arrangement managed through Stripe that authorizes an active Family_Plan for a Senior or a Partner per-member plan.
- **Stripe**: The third-party payment platform used for subscription billing, payment method management, and billing webhooks.
- **Billing_Account**: The Stripe customer associated with a Caregiver or Partner that holds payment methods and Subscriptions.

## Requirements

### Requirement 1: Account Registration and Role Assignment

**User Story:** As a family member, I want to create an account and identify myself as a caregiver, so that I can set up call protection for my relatives.

#### Acceptance Criteria

1. WHEN a visitor submits registration details with a valid email address (RFC 5322 format, maximum 254 characters) and a password between 8 and 128 characters, THE System SHALL create an authenticated account using Better Auth within 5 seconds.
2. IF a visitor submits registration details where the email is not valid RFC 5322 format, the email exceeds 254 characters, or the password is shorter than 8 characters or longer than 128 characters, THEN THE System SHALL reject the registration, return an error message indicating which field is invalid, and SHALL NOT create an account.
3. WHEN an account is created through the caregiver registration flow, THE System SHALL assign exactly the Caregiver role to that account.
4. WHEN a Senior account is created during Caregiver-initiated setup, THE System SHALL assign exactly the Senior role to that account.
5. IF a visitor submits a registration email that already belongs to an existing account (case-insensitive match), THEN THE System SHALL reject the registration, return an error message stating the email is already registered, and SHALL retain the existing account unchanged.
6. WHERE an account holds the Caregiver role, THE System SHALL grant that account access to the Caregiver_Dashboard and SHALL deny that account access to the Senior_Dashboard.
7. WHERE an account holds the Senior role, THE System SHALL grant that account access to the Senior_Dashboard and SHALL deny that account access to the Caregiver_Dashboard.

### Requirement 2: Caregiver-to-Senior Linking

**User Story:** As a caregiver, I want to manage one or more seniors, so that I can protect each relative under one account.

#### Acceptance Criteria

1. WHEN a Caregiver creates a Senior profile, THE System SHALL create an active Care_Link between that Caregiver and that Senior within 2 seconds.
2. THE System SHALL allow one Caregiver to hold active Care_Links to between 1 and 50 distinct Seniors.
3. IF a Caregiver attempts to create a Care_Link that would exceed 50 active Care_Links, THEN THE System SHALL reject the request, retain the Caregiver's existing Care_Links unchanged, and return an error indicating the maximum number of linked Seniors has been reached.
4. WHEN a Caregiver requests protection settings for a Senior, THE System SHALL return those settings only where an active Care_Link exists between the requesting Caregiver and that Senior.
5. IF a Caregiver requests data for a Senior to whom no active Care_Link exists, THEN THE System SHALL deny the request, return no settings, and return an authorization error indicating the Caregiver is not linked to that Senior.
6. WHEN a Caregiver removes a Care_Link to a Senior, THE System SHALL mark that Care_Link inactive within 2 seconds and revoke that Caregiver's access to that Senior's protection settings.

### Requirement 3: Senior Consent

**User Story:** As a senior, I want to consent before my calls are forwarded and screened, so that protection is set up with my agreement.

#### Acceptance Criteria

1. WHEN a Caregiver completes setup for a Senior, THE System SHALL require a valid Consent_Record for that Senior as a precondition for call forwarding activation.
2. THE Consent_Record SHALL capture the consenting Senior identifier, the Protection_Number, and a consent timestamp recorded in UTC with second-level precision.
3. IF no valid Consent_Record exists for a Senior, THEN THE System SHALL keep call forwarding inactive for that Senior.
4. IF a Consent_Record is submitted that is missing the Senior identifier, the Protection_Number, or the consent timestamp, THEN THE System SHALL reject the Consent_Record, keep call forwarding inactive for that Senior, and return an error indicating which required field is absent.
5. WHEN a Senior withdraws consent, THE System SHALL deactivate call forwarding for that Senior's Protection_Number within 60 seconds and provide confirmation to the Senior indicating that forwarding is inactive.

### Requirement 4: Protection Number Provisioning

**User Story:** As a caregiver, I want to provision a phone number that forwards to my senior's existing number, so that calls are screened before reaching them.

#### Acceptance Criteria

1. WHEN a Caregiver requests a Protection_Number for a Senior that does not already have an active Protection_Number, THE System SHALL provision a phone number through SignalWire, associate it with that Senior, and complete provisioning within 30 seconds of the request.
2. IF a Caregiver requests a Protection_Number for a Senior that already has an active Protection_Number, THEN THE System SHALL reject the request, retain the existing Protection_Number, and return an error indication stating that an active Protection_Number already exists.
3. WHEN a Protection_Number is provisioned, THE System SHALL store the Personal_Number to which connected calls forward, where the Personal_Number is a non-empty E.164-formatted value of at most 15 digits.
4. IF a Caregiver requests provisioning with a Personal_Number that is empty or not valid E.164 format, THEN THE System SHALL reject the request, SHALL NOT provision a Protection_Number, and SHALL return an error indication identifying the invalid Personal_Number.
5. WHEN a Protection_Number is provisioned, THE System SHALL configure the Protection_Number so that SignalWire routes inbound calls to the System's call-handling endpoint.
6. IF SignalWire returns an error during provisioning, THEN THE System SHALL report a provisioning failure to the Caregiver with an error indication describing the failure, SHALL leave the Senior without an active Protection_Number, and SHALL NOT store a Personal_Number for that provisioning attempt.
7. WHEN a Caregiver releases a Protection_Number, THE System SHALL release the number through SignalWire, deactivate forwarding for the associated Senior, and complete the release within 30 seconds of the request.
8. IF SignalWire returns an error while releasing a Protection_Number, THEN THE System SHALL report a release failure to the Caregiver with an error indication describing the failure and SHALL retain the Protection_Number as active for the associated Senior.

### Requirement 5: Known Contact Allowlist

**User Story:** As a caregiver, I want to save known numbers for my senior, so that trusted people reach my senior without screening.

#### Acceptance Criteria

1. WHEN a Caregiver submits a Caller_Number in E.164 format to add to a Senior's allowlist, THE System SHALL store that Caller_Number as a Known_Contact for that Senior within 2 seconds.
2. IF a Caregiver submits a Caller_Number that is not in valid E.164 format (1 to 15 digits with a leading plus sign), THEN THE System SHALL reject the request, SHALL NOT create a Known_Contact, and SHALL return an error indicating the number format is invalid.
3. IF a Caregiver submits a Caller_Number that already exists as a Known_Contact for the same Senior, THEN THE System SHALL reject the request, SHALL retain the existing Known_Contact unchanged, and SHALL return an error indicating the contact already exists.
4. WHEN an inbound call arrives on a Protection_Number from a Caller_Number that exactly matches a Known_Contact for the associated Senior, THE System SHALL connect the call to the Personal_Number without screening.
5. WHEN a Caregiver removes a Known_Contact, THE System SHALL delete that Known_Contact so that subsequent inbound calls from that Caller_Number are no longer treated as a Known_Contact for the associated Senior.
6. THE System SHALL store a display name of up to 100 characters alongside each Known_Contact.
7. WHERE a Known_Contact has a non-empty display name, WHEN a call arrives from that Caller_Number, THE System SHALL include that display name in the Call_Record for the call.

### Requirement 6: Inbound Call Screening

**User Story:** As a senior, I want unknown callers screened before they reach me, so that I avoid spam and fraud calls.

#### Acceptance Criteria

1. WHEN an inbound call arrives on a Protection_Number from an Unknown_Caller, THE System SHALL answer the call with the Screening_Agent within 3 seconds and SHALL NOT connect the call to the Personal_Number before a Risk_Assessment is produced.
2. WHEN the Screening_Agent completes an interaction, THE System SHALL produce a Risk_Assessment whose category is exactly one of Known, Allowed, Spam, or Fraud and whose risk score is an integer from 0 to 100 inclusive.
3. WHILE call forwarding is inactive for a Senior, THE System SHALL NOT connect inbound calls to that Senior's Personal_Number and SHALL record each such call with an outcome indicating the call was not forwarded.
4. IF a Risk_Assessment categorizes a call as Spam or Fraud, THEN THE System SHALL decline to connect the call to the Personal_Number, terminate the call, and record the call with its Risk_Assessment category.
5. WHEN a Risk_Assessment categorizes a call as Known or Allowed, THE System SHALL connect the call to the Personal_Number within 3 seconds of producing the Risk_Assessment.
6. IF the Screening_Agent cannot obtain call intent from the Caller within 60 seconds, THEN THE System SHALL decline to connect the call, terminate the call, and record the outcome as unscreened.

### Requirement 7: Call Recording and History

**User Story:** As a caregiver, I want a history of calls to my senior, so that I can review who called and what happened.

#### Acceptance Criteria

1. WHEN an inbound call completes on a Protection_Number, THE System SHALL create a Call_Record containing the Caller_Number, the call start timestamp in UTC, the call end timestamp in UTC, the screening outcome, the Risk_Assessment, and the call disposition.
2. IF creation of a Call_Record fails after the maximum of 3 retry attempts, THEN THE System SHALL record a Call_Record with a disposition value indicating a recording failure and SHALL preserve the Caller_Number and call start timestamp.
3. WHEN a Caregiver requests call history for a Senior to whom the Caregiver is linked, THE System SHALL return the Call_Records for that Senior ordered by call start timestamp in descending order, with the most recent record first.
4. IF a Caregiver requests call history for a Senior to whom the Caregiver is not linked, THEN THE System SHALL deny the request and return an authorization error indicating the Caregiver is not permitted to access that Senior's call history.
5. WHEN a Senior requests their own call history, THE System SHALL return the Call_Records for that Senior ordered by call start timestamp in descending order, with the most recent record first.
6. WHEN a call history request matches no Call_Records, THE System SHALL return an empty result set rather than an error.
7. THE System SHALL retain each Call_Record for a configurable retention period measured in whole days, where the configured value ranges from 1 to 3650 days and defaults to 365 days when no value is configured.
8. WHEN a Call_Record's age exceeds the configured retention period, THE System SHALL delete that Call_Record.

### Requirement 8: AI-Generated Call Reports

**User Story:** As a caregiver, I want AI-generated summaries of unknown-caller interactions, so that I can understand each call without listening to a recording.

#### Acceptance Criteria

1. WHEN the Screening_Agent completes an interaction with an Unknown_Caller, THE System SHALL generate a Call_Report summarizing the interaction and the Risk_Assessment within 30 seconds of interaction completion.
2. THE Call_Report SHALL contain the stated purpose of the call, the Risk_Assessment category, and a text explanation of the reason for that category, each as a separately labeled field.
3. WHEN the stated purpose of the call cannot be determined from the interaction, THE System SHALL record the stated purpose field as "undetermined" in the Call_Report.
4. WHEN a Caregiver requests a Call_Report for a call belonging to a Senior linked to that Caregiver, THE System SHALL return the Call_Report for that call within 5 seconds of the request.
5. IF a Caregiver requests a Call_Report for a call belonging to a Senior not linked to that Caregiver, THEN THE System SHALL deny the request and SHALL return an error response indicating the Caregiver is not authorized to view the Call_Report.
6. IF Call_Report generation fails for a call, THEN THE System SHALL store the Call_Record with the Risk_Assessment, SHALL mark the Call_Report as unavailable for that call, and SHALL retain the Call_Record without rollback.

### Requirement 9: Caregiver Dashboard

**User Story:** As a caregiver, I want a dashboard showing all activity for my seniors, so that I can oversee their call protection in one place.

#### Acceptance Criteria

1. WHEN a Caregiver opens the Caregiver_Dashboard, THE System SHALL display, within 3 seconds, the list of Seniors to whom that Caregiver holds an active Care_Link.
2. WHEN a Caregiver who holds no active Care_Links opens the Caregiver_Dashboard, THE System SHALL display an empty-state message indicating that no Seniors are linked and SHALL display no Senior data.
3. WHEN a Caregiver selects a linked Senior, THE System SHALL display, within 3 seconds, that Senior's Call_Records, Call_Reports, Known_Contacts, and Protection_Number status.
4. IF a Caregiver requests the dashboard data of a Senior to whom no active Care_Link exists, THEN THE System SHALL deny the request, display no data for that Senior, and return an authorization error indicating the Caregiver is not linked to that Senior.
5. WHEN a Caregiver adds a Known_Contact for a linked Senior through the Caregiver_Dashboard, THE System SHALL persist the Known_Contact and display the updated Known_Contacts list.
6. WHEN a Caregiver removes a Known_Contact for a linked Senior through the Caregiver_Dashboard, THE System SHALL delete the Known_Contact and display the updated Known_Contacts list.
7. IF an add or remove Known_Contact action fails, THEN THE System SHALL preserve the prior Known_Contacts state and return an error indication describing the failure.
8. THE Caregiver_Dashboard SHALL present each linked Senior's Protection_Number provisioning status as exactly one of the defined provisioning states.

### Requirement 10: Senior Dashboard

**User Story:** As a senior, I want a dashboard showing my own calls and contacts, so that I can see who is trying to reach me.

#### Acceptance Criteria

1. WHEN a Senior opens the Senior_Dashboard, THE System SHALL display that Senior's 20 most recent Call_Records, ordered from newest to oldest by call timestamp.
2. WHEN a Senior opens the Senior_Dashboard, THE System SHALL display each Call_Record with its caller identifier, call timestamp, and call outcome.
3. WHEN a Senior opens the Senior_Dashboard and that Senior has zero Call_Records, THE System SHALL display an empty-state message indicating that no calls have been received.
4. WHEN a Senior opens the Senior_Dashboard, THE System SHALL display that Senior's Known_Contacts.
5. WHEN a Senior opens the Senior_Dashboard, THE System SHALL display the Senior's call forwarding status as exactly one of the values "active" or "inactive".
6. THE Senior_Dashboard SHALL display only Call_Records, Known_Contacts, and call forwarding status belonging to the authenticated Senior.
7. IF a request to load Senior_Dashboard data fails, THEN THE System SHALL display an error message indicating that the dashboard data could not be loaded and SHALL NOT display another Senior's data.

### Requirement 11: Caller Number Normalization

**User Story:** As a caregiver, I want saved numbers matched reliably regardless of formatting, so that known callers are recognized consistently.

#### Acceptance Criteria

1. WHEN the System stores a Caller_Number or a Known_Contact number, THE System SHALL store it in E.164 format consisting of a leading plus sign followed by 1 to 15 digits.
2. WHEN an input telephone number omits a country code, THE System SHALL apply the configured default region to produce the E.164 form before storing it.
3. WHEN the System compares an inbound Caller_Number against Known_Contacts, THE System SHALL compare the E.164 normalized forms and SHALL treat two numbers as matching only when their full E.164 strings are character-for-character identical.
4. IF an inbound Caller_Number is empty, contains characters other than digits, spaces, hyphens, parentheses, or a single leading plus sign, or cannot be resolved to a valid E.164 value of 1 to 15 digits, THEN THE System SHALL treat the Caller as an Unknown_Caller and SHALL record a normalization-failure indication while retaining the original unmodified Caller_Number value.
5. FOR ALL telephone number values, normalizing an already-normalized E.164 number SHALL produce a character-for-character identical E.164 value (idempotence).

### Requirement 12: Family Plan Subscription Billing

**User Story:** As a caregiver, I want to subscribe to a monthly plan for each senior I protect, so that I can pay for call protection per relative.

#### Acceptance Criteria

1. WHEN a Caregiver initiates a Family_Plan subscription and holds no Billing_Account, THE System SHALL create a Billing_Account as a Stripe customer for that Caregiver within 10 seconds.
2. WHEN a Caregiver subscribes to a Family_Plan for a Senior to whom the Caregiver holds an active Care_Link, THE System SHALL create a Subscription for that Senior through Stripe at a monthly price between $14.99 and $19.99 inclusive per Senior.
3. IF a Caregiver attempts to subscribe to a Family_Plan for a Senior to whom no active Care_Link exists, THEN THE System SHALL reject the request, SHALL NOT create a Subscription, and SHALL return an authorization error indicating the Caregiver is not linked to that Senior.
4. IF a Caregiver attempts to create a Family_Plan Subscription for a Senior that already has an active Subscription, THEN THE System SHALL reject the request, SHALL retain the existing Subscription unchanged, and SHALL return an error indicating an active Subscription already exists for that Senior.
5. THE System SHALL activate call forwarding for a Senior only WHERE both a valid Consent_Record and an active Subscription exist for that Senior.
6. WHILE no active Subscription exists for a Senior, THE System SHALL keep call forwarding inactive for that Senior.
7. WHEN a Senior's Subscription transitions to past-due or canceled state, THE System SHALL deactivate call forwarding for that Senior's Protection_Number within 60 seconds of recording the state change.
8. WHEN a Caregiver requests the Subscriptions for the Seniors to whom the Caregiver holds active Care_Links, THE System SHALL return each such Subscription with its current state and monthly price within 5 seconds.
9. WHEN a Caregiver cancels a Subscription for a linked Senior, THE System SHALL request cancellation through Stripe and SHALL deactivate call forwarding for that Senior's Protection_Number within 60 seconds of recording the cancellation.
10. IF a Caregiver requests to view or cancel a Subscription for a Senior to whom no active Care_Link exists, THEN THE System SHALL deny the request, SHALL leave the Subscription unchanged, and SHALL return an authorization error indicating the Caregiver is not linked to that Senior.
11. IF Stripe returns an error while creating or canceling a Subscription, THEN THE System SHALL report a billing failure to the Caregiver with an error indication describing the failure and SHALL retain the prior Subscription state unchanged.
12. THE System SHALL treat Stripe as the system of record for Subscription state and SHALL reconcile each stored Subscription state from Stripe billing webhook events.

### Requirement 13: Partner Per-Member Billing

**User Story:** As a partner organization, I want to be billed a monthly fee per enrolled member, so that I can offer call protection to the members I manage.

#### Acceptance Criteria

1. WHEN a Partner is enrolled and holds no Billing_Account, THE System SHALL create a Billing_Account as a Stripe customer for that Partner within 10 seconds.
2. WHEN a Partner's per-member plan is established, THE System SHALL create a per-member Subscription through Stripe whose billed quantity equals the count of active enrolled Seniors managed by that Partner.
3. WHEN a Partner enrolls an additional member, THE System SHALL increase the Subscription's billed quantity by one, applying the updated quantity to the next billing cycle.
4. WHEN a Partner removes a member, THE System SHALL decrease the Subscription's billed quantity by one, applying the updated quantity to the next billing cycle, where the billed quantity SHALL NOT fall below zero.
5. WHEN a Partner requests billing information for its own members, THE System SHALL return the per-member Subscription state and billed quantity within 5 seconds.
6. IF a Partner requests to view or manage billing for a member not enrolled under that Partner, THEN THE System SHALL deny the request, SHALL leave the Subscription unchanged, and SHALL return an authorization error indicating the member is not managed by that Partner.
7. WHEN a Partner's per-member Subscription transitions to past-due or canceled state, THE System SHALL deactivate call forwarding for the Protection_Number of each Senior managed by that Partner within 60 seconds of recording the state change.
8. IF Stripe returns an error while creating or updating a Partner Subscription, THEN THE System SHALL report a billing failure to the Partner with an error indication describing the failure and SHALL retain the prior Subscription state and billed quantity unchanged.

### Requirement 14: Billing Webhook Reconciliation and Security

**User Story:** As the system, I want to process Stripe billing events reliably and securely, so that subscription state stays accurate and forwarding reflects payment status.

#### Acceptance Criteria

1. THE System SHALL expose a Stripe webhook endpoint that accepts Stripe billing event notifications.
2. WHEN a billing event is received at the Stripe webhook endpoint, THE System SHALL verify the Stripe webhook signature before processing the event.
3. IF the Stripe webhook signature verification fails, THEN THE System SHALL reject the event, SHALL NOT alter any Subscription state or forwarding state, and SHALL return an HTTP 400 response.
4. WHEN a signature-verified subscription lifecycle event with category created, updated, past_due, or canceled is received, THE System SHALL update the corresponding Subscription state and reconcile call forwarding activation for each affected Senior within 60 seconds of receiving the event.
5. WHEN the System receives a billing event whose Stripe event identifier matches a previously processed event, THE System SHALL produce the same resulting Subscription and forwarding state as the first processing of that event identifier and SHALL NOT apply the event a second time (idempotence).
6. IF a signature-verified billing event cannot be matched to a known Billing_Account or Subscription, THEN THE System SHALL record the unmatched event, SHALL NOT alter any forwarding state, and SHALL return an HTTP 200 response acknowledging receipt.
