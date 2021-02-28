const axios = require("axios");
const cheerio = require("cheerio");

// The names of the Airtable fields representing the last notified timestamp
// based on notification type.
const timestampFieldName = {
  EMAIL: "last_email",
  PHONE: "last_call",
};
// The names of the Airtable fields representing the user's desired threshold
// in between successive notifications.
const thresholdFieldName = {
  EMAIL: "min_email_threshold",
  PHONE: "min_call_threshold",
};

const sendEmail = async (apiKey, fromEmail, email, message) => {
  var data = JSON.stringify({
    personalizations: [{ to: [{ email: email }] }],
    from: { email: fromEmail },
    subject: `NYC COVID-19 Vaccine Availability Status Report: ${new Date().toGMTString()}`,
    content: [{ type: "text/html", value: message }],
  });

  try {
    return await axios({
      method: "post",
      url: "https://api.sendgrid.com/v3/mail/send",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      data: data,
    });
  } catch (error) {
    console.log(error);
  }
};

const callTwilio = async (
  twilioClient,
  twimlBinId,
  fromNumber,
  name,
  number,
  statuses
) => {
  // Compute total number of days in availabilities to dictate over the phone
  const numOfSlots = statuses.reduce(
    (memo, s) => (memo = memo + (s.totalAvailability || 0)),
    0
  );
  // Generate call phrase for speech-to-text to read out the list of
  // available locations. This is just adding an `and` after the penultimate
  // location if there are multiple locations.
  const locations = statuses.map((loc) => loc.name);

  // NYC has many locations so just truncating to the first few over the phone.
  let locationSlice;
  if (locations.length > 3) {
    locationSlice = locations.slice(0, 3);
    locationSlice.splice(locationSlice.length, 0, `and ${locations.length - 3} other locations.`);
  } else if (locations.length > 1) {
    locationSlice = locations;
    locationSlice.splice(locationSlice.length - 1, 0, "and");
  } else {
    locationSlice = locations;
  }

  const locationPhrase =
    encodeURIComponent(`${locations.length} total locations including` + locationSlice.join(", "));

  try {
    return await twilioClient.calls.create({
      from: fromNumber,
      to: number,
      url: `https://handler.twilio.com/twiml/${twimlBinId}?name=${name}&number=${numOfSlots}&locations=${locationPhrase}`,
    });
  } catch (error) {
    console.log(error);
  }
};

// Converts an array of availabilities into a basic HTML email for display
const convertHTML = (user, statuses) => {
  let locationBlocks = "";

  statuses.forEach((location) => {
    let availableBlocks = "<h3>Available Dates</h3>";

    Object.entries(location.availability).forEach((a) => {
      availableBlocks += `
          <li>${a[0]}: ${a[1]} available</li>
        `;
    });

    locationBlocks += `
          <hr>
          <h2>${location.name} - ${location.totalAvailability} slots available</h2>
          <h4>Address (if available): ${location.address}</h4>
          <p>Notes: ${location.notes}<p/>
          <p>Signup link (if available): ${location.url}</p>

          ${availableBlocks}
        `;
  });

  const locationPreferencePhrase = (user.locations && JSON.parse(user.locations).length > 0) ? "the following locations: " + JSON.parse(user.locations).join(', ') : "any available locations.";

  return `
    <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
      <html xmlns="http://www.w3.org/1999/xhtml" lang="en-GB">
      <head>
          <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
          <title>NYC COVID-19 Vaccine Availabilities</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      </head>
      <h1>NYC COVID-19 Vaccine Availabilities for ${user.name}</h1>
      <h2>Check NYC Vaccine List for more info: <a href="https://nycvaccinelist.com/">https://nycvaccinelist.com/</a></h2>
      <p>We looked at availabilites for ${locationPreferencePhrase}</p>

      ${locationBlocks}

      <hr>
      <small>Based on your user preferences, we will not e-mail you again for another ${user.min_email_threshold} minutes, even if more availabilities open up.</small>

    </html>
  `;
};

// Query Airtable for the list of users to process
const getUsers = async (context) => {
  try {
    return await axios({
      method: "get",
      url: `${context.AIRTABLE_API_ENDPOINT}`,
      headers: {
        Authorization: `Bearer ${context.AIRTABLE_API_KEY}`,
      },
    }).then((response) => {
      return response.data.records;
    });
  } catch (error) {
    console.log(error);
  }
};

// Update Airtable users
// Used to update last email send time and last phone send time
const updateUserInfo = async (context, users) => {
  // Given a list of users, just filter out so we have the User ID and timestamps
  // and send this bare minimum scope as payload because we will never be
  // updating the other fields via Airtable API (name, phone, email)
  const usersFilteredByTimestamps = users.map((user) => {
    return {
      id: user.id,
      fields: {
        [timestampFieldName["PHONE"]]: user.fields[timestampFieldName["PHONE"]],
        [timestampFieldName["EMAIL"]]: user.fields[timestampFieldName["EMAIL"]],
      },
    };
  });

  return await axios({
    method: "patch",
    url: `${context.AIRTABLE_API_ENDPOINT}`,
    headers: {
      Authorization: `Bearer ${context.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    data: JSON.stringify({
      records: usersFilteredByTimestamps,
    }),
  });
};

// Process a phone notification alert for a single user (if needed)
// If 1) There are availabilities for the user profile
//    2) Enough time has passed since the last notification (per user preferences)
// Then
//    Trigger a Twilio API or SendGrid API call to email/call the user
const processNotification = async (
  timestamp,
  context,
  user,
  userLocationAvailabilities,
  notificationType
) => {
  // When did we last notify user?
  const userTimeStamp = user[timestampFieldName[notificationType]];

  // How often does the user want to be notified?
  const userThreshold = user[thresholdFieldName[notificationType]]

  // Calculate time since last notification
  //  (Current runtime invocation timestamp - last notification timestamp)
  const deltaInMinutes = (userTimeStamp) => Math.round(
    (timestamp.getTime() -
      new Date(userTimeStamp)) /
    60000
  );

  const hasAvailabilities = userLocationAvailabilities.length > 0;

  // If user timestamp is undefined, send a notification (can happen during initialization use case; very first notification)
  // If user timestamp is defined, compare with threshold preference.
  const timeThresholdMet = !userTimeStamp || (deltaInMinutes(userTimeStamp) > userThreshold);

  if (
    (hasAvailabilities && timeThresholdMet) ||
    (context.DEBUG_MODE === "true")
  ) {
    switch (notificationType) {
      case "EMAIL":
        // Only attempt to send email if one is defined for user
        if (user.email && user.email.length > 0) {
          await sendEmail(
            context.SENDGRID_API_KEY,
            context.SENDGRID_SENDER,
            user.email.trim(),
            convertHTML(user, userLocationAvailabilities)
          );
          return Promise.resolve(new Date().toISOString());
        } else {
          return Promise.resolve(user[timestampFieldName[notificationType]]);
        }
      case "PHONE":
        // Only attempt to call phone if one is defined for user
        if (user.phone && user.phone.length > 0) {
          await callTwilio(
            context.getTwilioClient(),
            context.TWILIO_TWIML_BIN_ID,
            context.TWILIO_PHONE_NUMBER,
            user.name,
            user.phone.trim(),
            userLocationAvailabilities
          );
          return Promise.resolve(new Date().toISOString());
        } else {
          return Promise.resolve(user[timestampFieldName[notificationType]]);
        }
    }
  } else {
    // Return old timestamp since we are not sending notitifcation or
    // updating user object.
    return Promise.resolve(user[timestampFieldName[notificationType]]);
  }
};

const getVaccineStatus = async () => {
  try {
    return await axios({
      method: "get",
      url: "https://nycvaccinelist.com/",
    }).then((response) => {
      // API endpoint changes with each site deploy, so need to parse HTML response of index page
      const $ = cheerio.load(response.data);
      const nextData = $('html').find("#__NEXT_DATA__").contents().first().text();
      return JSON.parse(nextData).props.pageProps.locations.locationsWithSlots;
    });
  } catch (error) {
    console.log(error);
  }
};

// Process all users and send notifications if criteria is met.
// Loops through all users we have and processes email and phone alerts.
// Users will be notified if:
//    1) There are availabilities for their user profile.
//    2) Enough time has passed since our last notification per user preferences.
//       This is to avoid calling a phone every 5 mins if there is a 60 minute window
//       during which there are open appointment availabilities.
const processUsers = async (context, users, timestamp, results) => {
  const userPromises = users.map(async (user) => {
    return await processUser(timestamp, context, results, user.fields);
  });

  // Wait for all users to be processed and then return the users array, which
  // will have their updated timestamps if the user was notified via phone/email
  await Promise.all(userPromises);

  return users;
};

// Returns array of locations if available for user
// Returns empty array if none found
const filterResultsForUser = (results, user) => {
  // Assume matching with empty string if user profile has no value
  // ("" == first dose, "Second Dose" == second dose only)
  const dosePreference = user.dose && user.dose.length > 1 ? user.dose : "";
  // If user location param is empty/null, allow all locations
  // If locations has value (array of locations), then filter by locations.
  const locationPreference =
    user.locations && JSON.parse(user.locations).length > 0 ? JSON.parse(user.locations) : null;

  return results
    .filter((loc) => {
      return (
        loc.dose === dosePreference &&
        (locationPreference ? locationPreference.includes(loc.name) : true)
      );
    })
    .map((loc) => {
      return {
        name: loc.name,
        address: loc.address.join(" "),
        availability: loc.slots.reduce((memo, val) => {
          memo[val.date]
            ? (memo[val.date] = memo[val.date] + val.available)
            : (memo[val.date] = val.available);
          return memo;
        }, {}),
        url: loc.url,
        totalAvailability: loc.total_available,
        notes: loc.publicNotes,
      };
    });
};

const processUser = async (timestamp, context, results, user) => {
  // Filter based on locations data
  // Take into dose value — if empty string or null, assume matching with empty string
  // If "Second Dose"

  const availabilities = filterResultsForUser(results, user);

  // Process Email Notification
  // emailTimestamp will either
  //  1) return the old last-emailed timestamp if no notification was triggered
  //  2) return a new updated timestamp if a notification was triggered + delivered
  const emailTimestamp = await processNotification(
    timestamp,
    context,
    user,
    availabilities,
    "EMAIL"
  );
  // Update the user's last emailed timestamp based on the result of processNotification
  user.last_email = emailTimestamp;

  // Process Phone Notification
  // phoneTimestamp will either
  //  1) return the old last-called timestamp if no notification was triggered
  //  2) return a new updated timestamp if a notification was triggered + delivered
  const phoneTimestamp = await processNotification(
    timestamp,
    context,
    user,
    availabilities,
    "PHONE"
  );
  // Update the user's last called timestamp based on the result of processNotification
  user.last_call = phoneTimestamp;

  return Promise.resolve(user);
};

exports.handler = async function (context, event, callback) {
  // Get all users from Airtable that need to be processed
  let users = await getUsers(context);

  // Get NYC Vaccine Info
  const vaxData = await getVaccineStatus();

  // Runtime timestamp (going to just reuse when setting the "last called" and "last email" times)
  const runtimeTimestamp = new Date();

  // Collect all user profiles after processing.
  // We are (ah!) mutating the users array and updating their last send times if needed
  // and then sending this payload to airtable at the end to bulk update.
  //
  // NOTE: Airtable has a 10 record limit on these calls, so would need to be updated
  // to support more users.
  const processedUsers = await processUsers(
    context,
    users,
    runtimeTimestamp,
    vaxData
  );

  // // Update Airtable with all user definitions.
  // // We're mutating users... so just re-upload that payload
  await updateUserInfo(context, processedUsers);

  // Twilio Function default response
  return callback(null, "Success");
};
