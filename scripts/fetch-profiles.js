import { createClient } from "dynamodb";
import { writeCSVObjects } from "csv";
import { parse } from "flags";

// const dynamo = createClient();

async function main({ token }) {
  const skip = new Set(["slackbot", "jakub"]);
  const resp = await fetch("https://slack.com/api/users.list", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const users = (await resp.json()).members.filter(
    (x) => !(x.is_bot || x.deleted || skip.has(x.name))
  );

  const items = users.map((x) => ({
    email: x.profile.email,
    slackID: x.id,
    name: x.profile.real_name,
  }));

  const header = Object.keys(items[0]);
  const f = await Deno.open("./data/contacts.csv", {
    write: true,
    create: true,
    truncate: true,
  });
  try {
    await writeCSVObjects(f, items, { header });
  } finally {
    f.close();
  }
}

await main(parse(Deno.args));
