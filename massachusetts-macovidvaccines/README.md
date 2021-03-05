# Covid-19 Vaccine Appointment Notification System: Massachusetts

Twilio Serverless Function to monitor vaccine appointment availability changes by querying [MA Covid Vaccines](https://www.macovidvaccines.com/) scraper endpoint.

For a step-by-step guide on how to get setup, check out the [setup guide](https://ddxdevin.medium.com/build-a-covid-19-vaccine-appointment-notification-system-with-a-twilio-serverless-function-23cf328c01f4).

## Overview

![Service Diagram](assets/services.png)

## Eligibility 

We do not take into patient eligibility as part of the monitoring process. You should ensure you are eligible based on current local rules before setting up a check. If there are restrictions at a location (XYZ residents only, 65+), you can filter them out by specifying only a set of Locations in your `Locations` field but you would need to research the latest restrictions for each location in MA.

## MA-specific Details

For the `ma-notify` function and db schema, we allow a user to specify a list of the clinic locations they want to monitor. For example, only notify me if an appointment opens up for `"Fenway Park"`. 

Example value for `Locations` field: `["Fenway Park"]`

## "DB" Schema for MA

User Object

| Column      | Airtable Field Name | Description |
| ----------- | ----------- | ----------- |
| User Name      | `Name`       | Name of user is used in the phone call speech script |
| User Email   | `Email`        | SendGrid recipient email destination |
| Phone Number   | `Phone Number`        | Twilio calls this number to notify |
| Last Call   | `Last Call`        | DateTime of when we last called the user's phone number |
| Last Email   | `Last Email`        | DateTime of when we last emailed the user |
| Call Time Threshold   | `Min Minutes Between Calls`        | User preference for how many minutes should pass before we call them again. (We can check for available updates every 5 minutes and call a user if something becomes available but don't call them again until an hour later, if this value is set to `60`. This prevents repeated calls every time the cron job runs if there are consistently available appointments.) |
| Email Time Threshold   | `Min Minutes Between Emails`        | Similar to Call Time Threshold, but for emails. |
| Locations   | `Locations`        | Array of strings of the name of locations this user wants to monitor |
