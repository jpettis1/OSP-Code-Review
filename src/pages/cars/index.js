import { withFetchHar } from "next-fetch-har";
import "regenerator-runtime";

function MessageList({ messages }) {
  return (
    <>
      <h1>Cars List</h1>
      {messages.map(({ message }) => {
        return <div>{message}</div>;
      })}
    </>
  );
}

MessageList.getInitialProps = async (ctx) => {
  const res = await ctx.fetch("https://curriculum-api.codesmith.io/messages");
  const data = await res.json();
  return { messages: data };
};

export default withFetchHar(MessageList);
