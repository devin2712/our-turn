var axios = require("axios");

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
    subject: `CA COVID-19 Vaccine Availability Status Report: ${new Date().toGMTString()}`,
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
    (memo, s) => (memo = memo + (s.numOfDays || 0)),
    0
  );
  // Generate call phrase for speech-to-text to read out the list of
  // available locations. This is just adding an `and` after the penultimate
  // location if there are multiple locations.
  const locations = statuses.map((loc) => loc.locationName);
  if (locations.length > 1) {
    locations.splice(locations.length - 1, 0, "and");
  }
  const locationPhrase = encodeURIComponent(locations.join(", "));

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
const convertHTML = (statuses) => {
  let locationBlocks = "";

  statuses.forEach((location) => {
    let availableBlocks = "<h3>Available Dates</h3>";

    location.availability.forEach((a) => {
      if (a.available) {
        availableBlocks += `
          <li>${a.date}</li>
        `;
      }
    });

    locationBlocks += `
          <hr>
          <h2>${location.locationName}</h2>
          <h4>Address (if available): ${location.locationAddress}</h4>
          ${availableBlocks}
        `;
  });

  return `
    <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
      <html xmlns="http://www.w3.org/1999/xhtml" lang="en-GB">
      <head>
          <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
          <title>Boston COVID-19 Vaccine Availabilities</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      </head>
      <h1>CA COVID-19 Vaccine Availabilities</h1>
      <h3>Go to <a href="https://myturn.ca.gov/">MyTurn Website</a> and enter your information to book an appointment.</h3>
      ${locationBlocks}
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

// If eligible, return vaccineData string
// If not eligible, return empty string
const myTurnEligibilityCheck = async (user) => {
  // Mock questionnaire input
  const eligibilityCheckData = {
    eligibilityQuestionResponse: [
      {
        id: "q.screening.18.yr.of.age",
        value: ["q.screening.18.yr.of.age"],
        type: "multi-select",
      },
      {
        id: "q.screening.health.data",
        value: ["q.screening.health.data"],
        type: "multi-select",
      },
      {
        id: "q.screening.privacy.statement",
        value: ["q.screening.privacy.statement"],
        type: "multi-select",
      },
      {
        id: "q.screening.eligibility.age.range",
        value: user.age_range,
        type: "single-select",
      },
      {
        id: "q.screening.eligibility.industry",
        value: user.industry,
        type: "single-select",
      },
      {
        id: "q.screening.eligibility.county",
        value: user.county,
        type: "single-select",
      },
      {
        id: "q.screening.accessibility.code",
        type: "text",
      },
    ],
    url: "https://myturn.ca.gov/screening",
  };

  try {
    const response = await axios({
      method: "post",
      url: "https://api.myturn.ca.gov/public/eligibility",
      headers: {
        "Content-Type": "application/json",
      },
      data: eligibilityCheckData,
    });
    // If the user is eligible, MyTurn will respond with a "hashed" vaccineData string
    //  that will be used in subsequent responses to identify the user eligibility profile.
    if (response.data.eligible) {
      return response.data.vaccineData;
    } else {
      return "";
    }
  } catch (error) {
    console.log(error);
    return "";
  }
};

// Provided a hashed "vaccineData" identifier for the user, query for available clinic locations.
// Return empty array if no available locations
// Return array of locations if available with name, address, locationID (called extId) and the
//   vaccineData string associated with this location.
const myTurnLocationSearch = async (user, vaccineData) => {
  const locationData = {
    location: {
      lat: user.lat,
      lng: user.long,
    },
    fromDate: new Date().toISOString().slice(0, 10),
    vaccineData: vaccineData,
    locationQuery: {
      includePools: ["default"],
    },
    url: "https://myturn.ca.gov/location-select",
  };

  try {
    const response = await axios({
      method: "post",
      url: "https://api.myturn.ca.gov/public/locations/search",
      headers: {
        "Content-Type": "application/json",
      },
      data: locationData,
    });

    // If the user is eligible, MyTurn will respond with a "hashed" vaccineData string
    //  that will be used in subsequent responses to identify the user eligibility profile.
    if (response.data.locations && response.data.locations.length > 0) {
      return response.data.locations;
    } else {
      return [];
    }
  } catch (error) {
    console.log(error);
    return [];
  }
};

// locationVaccineData is the vaccineData string in the location object from locations query response
// locationId is called `extId` in myTurn API - represents the clinic location unique ID
// Returns: { locationId: "locationIdString", availability: [ {'date': '2021-01-01', 'available': true} ] }
//
// Only return a populated Object {} if there are availabilities; otherwise, return {}
const myTurnAvailabilityCheckForLocation = async (
  locationVaccineData,
  locationId
) => {
  const date = new Date();
  const checkData = {
    vaccineData: locationVaccineData,
    startDate: date.toISOString().slice(0, 10),
    endDate: new Date(date.setMonth(date.getMonth() + 2))
      .toISOString()
      .slice(0, 10),
    doseNumber: 1,
    url: "https://myturn.ca.gov/appointment-select",
  };

  try {
    const response = await axios({
      method: "post",
      url: `https://api.myturn.ca.gov/public/locations/${locationId}/availability`,
      headers: {
        "Content-Type": "application/json",
      },
      data: checkData,
    });

    if (response.data.availability && response.data.availability.length > 0) {
      // There are open availabilities on some days!
      return {
        locationId: response.data.locationExtId,
        availability: response.data.availability,
      };
    } else {
      return {};
    }
  } catch (error) {
    console.log(error);
    return {};
  }
};

const getMyTurnAvailabilities = async (user) => {
  const vaccineData = await myTurnEligibilityCheck(user);

  // If vaccineData is an empty string, it means user is not eligible yet.
  // Break out early and return empty array, signifying no availabilities.
  if (vaccineData === "") {
    return Promise.resolve([]);
  }

  const availableLocations = await myTurnLocationSearch(user, vaccineData);

  // If no locations available, break out early.
  if (availableLocations.length === 0) {
    return Promise.resolve([]);
  }

  // Translate all locations into an Object for easy access
  // { locationExtId123ABC: { name: "Location Name", address: "Location Address" } }
  const locationDefinitions = availableLocations.reduce((memo, loc) => {
    memo[loc.extId] = { name: loc.name, address: loc.displayAddress };
    return memo;
  }, {});

  // For each availabile location, iteratively query the availability endpoint to collect how many days are available.
  return await Promise.all(
    availableLocations
      .map(async (loc) => {
        const locationStatus = await myTurnAvailabilityCheckForLocation(
          loc.vaccineData,
          loc.extId
        );

        if (Object.entries(locationStatus).length > 0) {
          return Promise.resolve({
            locationName: locationDefinitions[locationStatus.locationId].name,
            locationAddress:
              locationDefinitions[locationStatus.locationId].address,
            availability: locationStatus.availability,
            numOfDays: locationStatus.availability.filter((d) => d.available)
              .length,
          });
        } else {
          return Promise.resolve(null);
        }
      })
      .filter((obj) => obj)
  );
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
  // Calculate time since last notification
  //  (Current runtime invocation timestamp - last notification timestamp)
  const deltaInMinutes = Math.round(
    (timestamp.getTime() -
      new Date(user[timestampFieldName[notificationType]])) /
    60000
  );

  const hasAvailabilities = userLocationAvailabilities.length > 0;
  const timeThresholdMet =
    deltaInMinutes > user[thresholdFieldName[notificationType]];

  if (
    (hasAvailabilities && timeThresholdMet) ||
    context.DEBUG_MODE === "true"
  ) {
    switch (notificationType) {
      case "EMAIL":
        // Only attempt to send email if one is defined for user
        if (user.email && user.email.length > 0) {
          await sendEmail(
            context.SENDGRID_API_KEY,
            context.SENDGRID_SENDER,
            user.email,
            convertHTML(userLocationAvailabilities)
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
            user.phone,
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

// Process all users and send notifications if criteria is met.
// Loops through all users we have and processes email and phone alerts.
// Users will be notified if:
//    1) There are availabilities for their user profile.
//    2) Enough time has passed since our last notification per user preferences.
//       This is to avoid calling a phone every 5 mins if there is a 60 minute window
//       during which there are open appointment availabilities.
const processUsers = async (context, users, timestamp) => {
  const userPromises = users.map(async (user) => {
    return await processUser(timestamp, context, user.fields);
  });

  // Wait for all users to be processed and then return the users array, which
  // will have their updated timestamps if the user was notified via phone/email
  await Promise.all(userPromises);

  return users;
};

const processUser = async (timestamp, context, user) => {
  const results = await getMyTurnAvailabilities(user);

  // Process Email Notification
  // emailTimestamp will either
  //  1) return the old last-emailed timestamp if no notification was triggered
  //  2) return a new updated timestamp if a notification was triggered + delivered
  const emailTimestamp = await processNotification(
    timestamp,
    context,
    user,
    results,
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
    results,
    "PHONE"
  );
  // Update the user's last called timestamp based on the result of processNotification
  user.last_call = phoneTimestamp;

  return Promise.resolve(user);
};

exports.handler = async function (context, event, callback) {
  // Get all users from Airtable that need to be processed
  let users = await getUsers(context);

  // Runtime timestamp (going to just reuse when setting the "last called" and "last email" times)
  const runtimeTimestamp = new Date();

  // Collect all user profiles after processing.
  // We are (ah!) mutating the users array and updating their last send times if needed
  // and then sending this payload to airtable at the end to bulk update.
  //
  // NOTE: Airtable has a 10 record limit on these calls, so would need to be updated
  // to support more users.
  const processedUsers = await processUsers(context, users, runtimeTimestamp);

  // // Update Airtable with all user definitions.
  // // We're mutating users... so just re-upload that payload
  await updateUserInfo(context, processedUsers);

  // Twilio Function default response
  return callback(null, "Success");
};