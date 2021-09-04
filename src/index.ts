import { DateTime } from "luxon";
import puppeteer, { Page } from "puppeteer";
import fs from "fs";
import inquirer from "inquirer";

async function login(
  email: string,
  username: string,
  password: string
): Promise<Page> {
  console.log(`Logging in as ${username}`);

  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto("https://skolplattformen.stockholm.se", {
    waitUntil: "networkidle0",
  });
  await page.type("input[type=email]", email);
  await page.click("input[type=submit]");

  const realmXPath = '//a[contains(., "Elever")]';
  await page.waitForXPath(realmXPath);
  const [switchRealm] = await page.$x(realmXPath);
  await switchRealm.click();

  const passwordXPath =
    '//a[contains(., "Logga in med användarnamn och lösenord")]';
  await page.waitForXPath(passwordXPath);
  const [loginWithPassword] = await page.$x(passwordXPath);
  await loginWithPassword.click();

  await page.waitForSelector("input[name=user]");
  await page.type("input[name=user]", username);
  await page.type("input[name=password]", password);
  await page.click("button[type=submit]");

  const dontStaySignedInSelector = "input#idBtn_Back";
  await page.waitForSelector(dontStaySignedInSelector);
  await page.click(dontStaySignedInSelector);

  await page.waitForSelector("a[data-navigationcomponent=SiteHeader]");

  console.log("🎉 Login successful!");

  return page;
}

interface GetTimetablesResponse {
  data: {
    getPersonalTimetablesResponse: {
      studentTimetables: StudentTimetableInfo[];
    };
  };
}

interface StudentTimetableInfo {
  firstName: string;
  lastName: string;
  personGuid: string;
  schoolGuid: string;
  schoolID: string;
  timetableID: string;
  unitGuid: string;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  bColor: string;
  fColor: string;
  id: number;
  parentId: number;
  type: string;
  lessonGuids: string[];
}

interface S24Lesson {
  guidId: string;
  texts: string[];
  timeStart: string;
  timeEnd: string;
  dayOfWeekNumber: number;
  blockName: string;
}

interface Lesson {
  course: string;
  location?: string;
  teacher?: string;
  start: DateTime;
  end: DateTime;
  color: string;
}

interface RenderTimetableResponse {
  error?: any;
  data: {
    textList: any[];
    boxList: Box[];
    lineList: any[];
    lessonInfo: S24Lesson[] | null;
  };
}

function lessonsToCsv(lessons: Lesson[]): string {
  const header = [
    "Subject",
    "Start Date",
    "Start Time",
    "End Date",
    "End Time",
    "All Day Event",
    "Description",
    "Location",
    "Private",
    "Recurring",
  ].join(",");

  return [header]
    .concat(
      lessons.map((lesson) => {
        return [
          lesson.course,
          lesson.start.toLocaleString(DateTime.DATE_SHORT),
          lesson.start.toLocaleString(DateTime.TIME_SIMPLE),
          lesson.end.toLocaleString(DateTime.DATE_SHORT),
          lesson.end.toLocaleString(DateTime.TIME_SIMPLE),
          "FALSE",
          lesson.teacher,
          lesson.location,
          "TRUE",
          "N",
        ].join(",");
      })
    )
    .join("\n");
}

async function fetchTimetables(
  skolplattformen: Page,
  year: number,
  weekNumbers: number[]
) {
  const moreSelector = 'button[aria-label="Fler alternativ"]';
  await skolplattformen.waitForSelector(moreSelector);
  await skolplattformen.click(moreSelector);
  const scheduleSelector = "a[name=Schemavisaren]";
  await skolplattformen.waitForSelector(scheduleSelector);
  await skolplattformen.click(scheduleSelector);

  const newTarget = await skolplattformen
    .browser()
    .waitForTarget((target) => target.opener() === skolplattformen.target()); //check that you opened this page, rather than just checking the url
  const page = await newTarget.page();
  if (!page) throw Error("no schedule page!");
  await page.setRequestInterception(true);

  let scope: string = "";

  page.on("request", (r) => {
    const headers = r.headers();

    if (!scope && headers["x-scope"]) {
      scope = headers["x-scope"];
    }

    r.continue();
  });

  let timetables: GetTimetablesResponse | undefined;

  page.on("response", (r) => {
    if (
      r.url() ===
      "https://fns.stockholm.se/ng/api/services/skola24/get/personal/timetables"
    ) {
      r.json().then((res) => (timetables = res));
    }
  });

  await page.waitForNavigation({ waitUntil: "networkidle0" });

  if (scope === "") {
    throw new Error("failed to capture X-Scope");
  }

  if (!timetables) {
    throw new Error("got no timetables");
  }

  const [info] =
    timetables.data.getPersonalTimetablesResponse.studentTimetables;

  console.log(
    `Reading timetables belonging to ${info.firstName} ${info.lastName}`
  );

  async function getLessons(
    weekNumber: number,
    year: number
  ): Promise<Lesson[]> {
    const {
      data: { key },
    } = await page!.evaluate((scope) => {
      return fetch("/ng/api/get/timetable/render/key", {
        method: "POST",
        headers: { "X-Scope": scope },
      }).then((res) => res.json());
    }, scope);

    const req = JSON.stringify({
      renderKey: key,
      host: "fns.stockholm.se",
      unitGuid: info.unitGuid,
      startDate: null,
      endDate: null,
      scheduleDay: 0,
      blackAndWhite: false,
      width: 732,
      height: 550,
      selectionType: 5,
      selection: info.personGuid,
      showHeader: false,
      periodText: "",
      week: weekNumber,
      year,
      privateFreeTextMode: null,
      privateSelectionMode: true,
      customerKey: "",
    });

    console.log(`>> W${weekNumber}Y${year}`);

    const json = await page!.evaluate(
      (scope, req) => {
        return fetch("/ng/api/render/timetable", {
          method: "POST",
          headers: { "X-Scope": scope, "Content-Type": "application/json" },
          body: req,
        }).then((res) => res.text());
      },
      scope,
      req
    );

    const { data }: RenderTimetableResponse = JSON.parse(json);

    const boxes: Record<string, Box> = Object.fromEntries(
      data.boxList
        ?.filter((b) => b.type === "Lesson")
        .map((b) => [b.lessonGuids[0], b]) ?? []
    );

    const d = DateTime.fromObject({
      weekNumber,
      weekYear: year,
    }).startOf("week");

    return (
      data.lessonInfo?.map((l) => {
        const box = boxes[l.guidId];
        const [course, teacher, location] = l.texts;

        const start = d.set({
          weekday: l.dayOfWeekNumber,
          second: parseTime(l.timeStart),
        });
        const end = d.set({
          weekday: l.dayOfWeekNumber,
          second: parseTime(l.timeEnd),
        });

        return {
          start,
          end,
          color: box.bColor,
          course,
          teacher: course.toLocaleLowerCase().includes("lunch")
            ? "https://skolorna.com"
            : teacher,
          location,
        };
      }) ?? []
    );
  }

  let promises = [];

  const lessons = (
    await Promise.all(weekNumbers.map((w) => getLessons(w, year)))
  ).flat();

  console.log(`Parsed ${lessons.length} lessons`);

  const csv = lessonsToCsv(lessons);

  const output = "result.csv";

  console.log(`Writing to ${output}`);

  fs.writeFileSync(output, csv, "utf8");

  await page.browser().close();
}

function parseTime(input: string): number {
  return input
    .split(":")
    .reduce((t, s, i) => t + parseInt(s) * 60 ** (2 - i), 0);
}

inquirer
  .prompt([
    {
      type: "input",
      message: "Email",
      name: "email",
    },
    {
      type: "input",
      message: "Username",
      name: "username",
      validate: (u) => u.length > 0,
    },
    {
      type: "password",
      message: "Password",
      name: "password",
    },
  ])
  .then(async ({ email, username, password }) => {
    const page = await login(email, username, password);

    const { year } = await inquirer.prompt([
      {
        type: "number",
        default: DateTime.now().year,
        name: "year",
        message: "Year",
      },
    ]);

    const { weekStart } = await inquirer.prompt([
      {
        type: "number",
        default: DateTime.now().weekNumber,
        name: "weekStart",
        message: "Starting week number",
      },
    ]);

    const { weekEnd } = await inquirer.prompt([
      {
        type: "number",
        default: DateTime.fromObject({ year }).endOf("year").weekNumber,
        name: "weekEnd",
        message: "Ending week number",
      },
    ]);

    const weekNumbers = Array.from({ length: weekEnd - weekStart + 1 }).map(
      (_, i) => i + weekStart
    );

    fetchTimetables(page, year, weekNumbers);
  });

// main();
