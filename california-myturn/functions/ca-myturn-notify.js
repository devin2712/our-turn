const axios = require("axios");

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
  // Compute total number of days in availabilities for first dose to dictate over the phone
  const numOfSlots = statuses.reduce(
    (memo, s) => (memo = memo + ((s.availability.dose1 && s.availability.dose1.length) || 0)),
    0
  );

  // Generate call phrase for speech-to-text to read out the list of
  // available locations. This is just adding an `and` after the penultimate
  // location if there are multiple locations.
  const locations = statuses.map((loc) => loc.locationName);

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

  // Read out only the first few
  const locationPhrase = encodeURIComponent(locationSlice.join(", "));
  const datesPhrase = encodeURIComponent(numOfSlots === 1 ? 'is 1 date' : `are ${numOfSlots} dates`);
  const locationCountPhrase = encodeURIComponent(statuses.length === 1 ? "1 location" : `${statuses.length} locations`);

  try {
    return await twilioClient.calls.create({
      from: fromNumber,
      to: number,
      url: `https://handler.twilio.com/twiml/${twimlBinId}?name=${name}&number=${datesPhrase}&locationCount=${locationCountPhrase}&locations=${locationPhrase}`,
    });
  } catch (error) {
    console.log(error);
  }
};

// Converts an array of availabilities into a basic HTML email for display
const convertHTML = (user, statuses, doseDaysInBetween) => {
  let locationBlocks = "";

  statuses.forEach((location) => {
    let dose1Block = "<h3>Dose 1 Available Dates</h3>";
    location.availability.dose1.forEach((a) => {
      dose1Block += `<li>${a.date}</li>`;
    })

    let dose2Block = `<h3>Dose 2 Available Dates (${doseDaysInBetween} days after first dose)</h3>`;
    location.availability.dose2.forEach((a) => {
      dose2Block += `<li>${a.date}</li>`;
    })

    locationBlocks += `
          <hr>
          <h2>${location.locationName}</h2>
          <h4>Address (if available): ${location.locationAddress}</h4>
          ${dose1Block}
          ${dose2Block}
        `;
  });

  return `
    <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
      <html xmlns="http://www.w3.org/1999/xhtml" lang="en-GB">
      <head>
          <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
          <title>CA COVID-19 Vaccine Availabilities</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      </head>
      <h1>CA COVID-19 Vaccine Availabilities for ${user.name}</h1>
      <p>We just detected availabilities for <strong>${user.age_range}</strong> years old, living/working in <strong>${user.county} County</strong> within the <strong>${user.industry}</strong> industry. Go to <strong><a href="https://myturn.ca.gov/">MyTurn Website</a></strong> and enter your information to book an appointment using the same values.</p>
      <p>Note: We have checked that there are availabilities for both doses so you should be able to book both slots at the same time.</p>
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
        id: "q.screening.underlying.health.condition",
        value: "Yes",
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
  locationId,
  numOfDaysBetweenDoses
) => {
  const checkData = (date, doseNumber) => ({
    vaccineData: locationVaccineData,
    startDate: date.toISOString().slice(0, 10),
    endDate: new Date(date.getFullYear(), date.getMonth() + 2, date.getDate())
      .toISOString()
      .slice(0, 10),
    doseNumber: doseNumber,
    url: "https://myturn.ca.gov/appointment-select",
  });

  try {
    // CA MyTurn will attempt to book both dose appointments during the registration process.
    // We should only send a notification that it's possible to book in the system if there are availabilities:
    //    1) From today onwards for dose 1
    //    2) From <the first available first dose date> + 21 days onwards
    // 
    // If there are only availabilities for the first dose but you can't book the second dose, then don't send notification.
    const dose1Response = await axios({
      method: "post",
      url: `https://api.myturn.ca.gov/public/locations/${locationId}/availability`,
      headers: {
        "Content-Type": "application/json",
      },
      data: checkData(new Date(), 1),
    });

    // Break out early if no availability 
    if (!dose1Response.data.availability || dose1Response.data.availability.length === 0 || dose1Response.data.availability.filter((a) => a.available).length === 0) {
      return {};
    }

    // Let's assume the Pfizer use case with 21 days, although this can be configured via the ENV variable (CA_MYTURN_DOSE_DAYS_BETWEEN).
    // The only way to programmatically get the correct number of days in between (21 vs 28) is to use the Reserve API.
    // We are going to avoid calling the reserve API to avoid abusing the registration system.
    // 
    // Assume that the seed date is the min date from the dose 1 response
    const firstAvailableFirstDoseDate = new Date(dose1Response.data.availability.filter((a) => a.available)[0].date)

    // Offset JS date timezone issue to ensure the DAY is correct
    const normalizedFirstDate = new Date(firstAvailableFirstDoseDate.getTime() - firstAvailableFirstDoseDate.getTimezoneOffset() * -60000)

    // Add the number of days in between doses to the first-available first-dose appointment date.
    let secondDoseStartDate = new Date(normalizedFirstDate);
    secondDoseStartDate.setDate(secondDoseStartDate.getDate() + Number(numOfDaysBetweenDoses));

    const dose2Response = await axios({
      method: "post",
      url: `https://api.myturn.ca.gov/public/locations/${locationId}/availability`,
      headers: {
        "Content-Type": "application/json",
      },
      data: checkData(secondDoseStartDate, 2),
    });

    if (dose2Response.data.availability && dose2Response.data.availability.length > 0) {
      return {
        locationId: dose1Response.data.locationExtId,
        dose1Dates: dose1Response.data.availability,
        dose2Dates: dose2Response.data.availability
      }
    } else {
      return {};
    }
  } catch (error) {
    console.log(error);
    return {};
  }
};

// Quick optimization to not fetch data unless we need to. 
// If neither timestamps (phone/email) have met their time thresholds, skip this user.
const shouldFetchData = (timestamp, user) => {
  // if no email defined  => email not eligible
  //
  // if email defined AND no min_email_threshold defined => email eligible (always send email because no threshold is defined)
  // if email defined AND no last_email defined => eligible (we've never sent them an email)
  // if email defined AND min_email_threshold defined
  //    AND     time - last_email > threshold   => eligible (we've sent them email + enough time has passed)
  const emailEligible = user.email !== undefined && (
    (!user[thresholdFieldName['EMAIL']] || (Math.round(
      (timestamp.getTime() -
        new Date(user[timestampFieldName['EMAIL']])) /
      60000
    )) >= user[thresholdFieldName['EMAIL']]) || !user[timestampFieldName['EMAIL']]
  );

  // if no phone defined  => phone not eligible
  //
  // if phone defined AND no min_phone_threshold defined => phone eligible (always call phone because no threshold is defined)
  // if phone defined AND no last_phone defined => eligible (we've never sent them an phone)
  // if phone defined AND min_phone_threshold defined
  //    AND     time - last_phone > threshold   => eligible (we've sent them phone + enough time has passed)
  const phoneEligible = user.phone !== undefined && (
    (!user[thresholdFieldName['PHONE']] || (Math.round(
      (timestamp.getTime() -
        new Date(user[timestampFieldName["PHONE"]])) /
      60000
    )) >= user[thresholdFieldName['PHONE']]) || !user[timestampFieldName['PHONE']]
  );

  // If either are eligible, then we should fetch data and attempt to find appointments.
  return emailEligible || phoneEligible;
}

const getMyTurnAvailabilities = async (timestamp, context, user) => {
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
  const locations = await Promise.all(
    availableLocations.map(async (loc) => {
      const locationStatus = await myTurnAvailabilityCheckForLocation(
        loc.vaccineData,
        loc.extId,
        context.CA_MYTURN_DOSE_DAYS_BETWEEN || 21
      );

      // If nothing came back, that means there aren't enough appointments to book 1 and 2
      if (Object.entries(locationStatus).length === 0) {
        return Promise.resolve(null);
      }

      // Per this quick implementation, if there is a response from myTurnAvailabilityCheckForLocation,
      // we can assume that there are availability entries for dose1 and dose2. But we need to validate 
      // that at least one date myTurn provides has available==true.
      // We can assume that all dates in the dose2 availability object are 21 days ahead.
      const availableLocationSlots = {
        locationId: locationStatus.locationId,
        dose1AvailableDates: locationStatus.dose1Dates.filter((a) => a.available),
        dose2AvailableDates: locationStatus.dose2Dates.filter((a) => a.available)
      }

      // If there are available dates in both dose 1 and dose 2, then a user can book and we should notify them.
      if (availableLocationSlots.dose1AvailableDates.length > 0 && availableLocationSlots.dose2AvailableDates.length > 0) {
        return Promise.resolve({
          locationName: locationDefinitions[locationStatus.locationId].name,
          locationAddress:
            locationDefinitions[locationStatus.locationId].address,
          availability: {
            dose1: availableLocationSlots.dose1AvailableDates,
            dose2: availableLocationSlots.dose2AvailableDates
          },
          numOfDays: availableLocationSlots.dose1AvailableDates.length + availableLocationSlots.dose2AvailableDates.length,
        })
      } else {
        return Promise.resolve(null);
      }
    })
  );

  // Filter by non-null objects. Only return locations with data.
  return locations.filter((obj) => obj);
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

  // If user timestamp is undefined, we've never sent them a notification, so send them a notification now for the first time.
  // If user threshold is undefined, send a notification as there is no preference to back off successive notifications.
  //
  // If user threshold is defined and we've sent them a notification before, compare with threshold preference to ensure time difference.
  const timeThresholdMet = !userThreshold || !userTimeStamp || (deltaInMinutes(userTimeStamp) > userThreshold);

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
            convertHTML(user, userLocationAvailabilities, context.CA_MYTURN_DOSE_DAYS_BETWEEN || 21)
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
    // Return old timestamp since we are not sending notification or
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
  // If time thresholds haven't been met for neither phone nor email, don't even attempt to fetch data.
  if (!shouldFetchData(timestamp, user) && !context.DEBUG_MODE) {
    return Promise.resolve(null);
  }

  const results = await getMyTurnAvailabilities(timestamp, context, user);

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
