# Google-Contacts-Birthday-Calendar

Sync birthdays from Google Contacts into a dedicated Google Calendar using Apps Script.

Automatic syncing of Google Contacts birthdays as recurring events with reminders in Google Calendar

# Introduction

Due to regulatory requirements, birthdays added to Google Contacts are not shown in Google Calendar, even when birthday syncing is enabled.

As a result, you must either manually create a recurring birthday event for each contact and keep it updated, or risk missing important birthdays.

Google Birthday Calendar uses Google Apps Script to automatically create and sync a recurring calendar event for every contact that has a birthday.

# Key benefits:

Receive birthday reminders in Google Calendar

Maintain birthday data in one place, alongside other contact information in Google Contacts

Automatically sync updates once per day in the background, with email notifications only for issues or occasional status updates

# Setup

A) Code and resources

Open https://script.google.com in your browser

Create a new project and name it “Birthday Calendar”

Open the code.gs file from the GitHub repository, select all contents, and copy them to the clipboard

Return to the Apps Script editor, ensure you are in code.gs (which may only contain an empty myFunction()), select all content, and replace it by pasting the copied code

In the left pane, click the “+” button next to Services, scroll down, select People API, and click Add

Repeat the step above and add Google Calendar API

Click “Save project to Drive”

B) Configuration and permissions

Adjust the configuration using the const declarations in the “CONFIGURATION” section (see comments above each setting)

For testing, set const debug = true to receive detailed progress updates in the console

Click Run and grant the required permissions

When prompted with “Authorization required,” click Review Permissions and select the Google account that contains the contacts and calendar you want to sync

You will see a warning that the app is not verified by Google. You can either review the source code or proceed

Click Advanced, then select “Go to Birthday Calendar (unsafe)”

Sign in again and grant the requested permissions:

Mail access: used for authentication and email notifications in case of errors

Contacts access: used to read contacts and detect birthdays

Calendar access: used to create and update birthday events

You will receive a security alert email about the granted permissions. Confirm that it was you

C) Automation

Once everything is working, set debug back to false

Open Triggers from the left-hand pane and click Add Trigger

Configure the trigger with the following settings:

Function to run: update_birthdays

Deployment to run: Head

Event source: Time-driven

Time-based trigger: Day timer

Time of day: 10pm to 11pm

Failure notification: default

Click Save

# Important

Google enforces a maximum execution time of 6 minutes per script. To stay within this limit, the script stops execution after approximately 5 minutes and 30 seconds and resumes on the next scheduled run, continuing where it left off.

You will receive an email notification if this occurs.

# Note

Once per month, the script sends a brief “sign of life” email to confirm that everything is still running as expected.

# Usage

Continue using Google Contacts and Google Calendar as usual. Simply enter birthdays directly in your contacts, and you will automatically receive birthday reminders via Google Calendar.

# Contributors

Issues and code contributions are welcome via GitHub.

# License

This code is released under the GNU General Public License v3.0. You are free to use it in your own projects. References to this repository are appreciated.
