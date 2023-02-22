import { useRouter } from "next/router";
import { withFetchHar } from "next-fetch-har";
import "regenerator-runtime";

function Car({ car }) {
  const router = useRouter();
  const { id } = router.query;
  return (
    <>
      <h1>Hello {id}</h1>
      {/* {car.map(({ message }) => {
        return <div>{message}</div>;
      })} */}
      <div>{car.color}</div>
    </>
  );
}

// Car.getInitialProps = async (ctx) => {
//   const res = await ctx.fetch("https://curriculum-api.codesmith.io/messages");
//   const data = await res.json();
//   return { car: data };
// };

// export default withFetchHar(Car);
export default Car;

// export async function getServerSideProps({ params, ctx }) {
//   const req = await fetch(`http://localhost:3000/${params.id}.json`);
//   const data = await req.json();
//   console.log(data);
//   return {
//     props: { car: data },
//   };
// }

export async function getStaticProps({ params }) {
  const req = await fetch(`http://localhost:3000/${params.id}.json`);
  const data = await req.json();

  return {
    props: { car: data },
  };
}

// export async function getStaticPaths() {
//   const req = await fetch("http://localhost:3000/cars.json");
//   const data = await req.json();
//   const paths = data.map((car) => {
//     return { params: { id: car } };
//   });
//   return {
//     paths,
//     fallback: false,
//   };
// }
