

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY || "";
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    });
    const json: any = await res.json();
    if (!json.data) {
      console.error("No data:", json);
      return;
    }
    const models = json.data.map((m: any) => m.id);
    console.log("ALL SONNET MODELS:");
    console.log(models.filter((m: string) => m.includes("sonnet")));
    console.log("\nALL HAIKU MODELS:");
    console.log(models.filter((m: string) => m.includes("haiku")));
  } catch (err) {
    console.error("Error fetching:", err);
  }
}

main();
