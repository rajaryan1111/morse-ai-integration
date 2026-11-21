
import * as morse from "@morsehq-dev/sdk";

morse.init();

await morse.run(
  { agentName: "connection-test" },
  async () => {
    console.log("Starting Morse integration test...");

    await new Promise(resolve => setTimeout(resolve, 500));

    console.log("Test completed.");
  }
);

await morse.flush();

console.log("Morse flush completed.");
