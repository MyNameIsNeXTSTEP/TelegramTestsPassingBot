# Telegram Tests Passing Bot
A telegram bot, admin panel and personal account for passing tests like in universities or schools

## Development plan

### Users Bot (client bot)

Need to create a telegram general bot that could be setup providing to it the tests sources (texts/files/records),
and the goal of the bot would be to provide a user experience to try to pass them, see correct/incorrect answers, statistics etc.

When the user starts the bot - it prompts him to choose the faculty and the subject, then which types of tests to work on - exams or credits (fail/pass).
Then when a user falls into the selected scenario the backend of the bot should load its assosiated tests to present to him.

Then the user experience should like a quize mode where a user tries to pass the tests of a certain subject.

There should be several regimes:
- One test. Each test car is shown to choose the correct answer from, after its submition the UI shows success or error and correct/incorrect answer. Then loads next test card.

- Pack. There's a process bar and 10 tests selected randomly to be given to a user to pass.

- Exam prep. Similar to the pack, but there're 30 tests questions/cards, and each error adds 3 more tests to the process. There's a counter or errors. If the total errors in this regime is 3 -> then the exam is failed, otherwise passed.

### Admin panel (WEB app / telegram mini-app)

Need to create some sort of a WEB admin-panel (also maybe admin telegram bot and mini-app with that WEB admin-panel) for the admin
to be able to manage the bot settings, details, texts, tests etc.

---

The main users bot is aimed to be commercial at some stage, so from the start it should provide a freemium model,
where for example 3-5 tests a day are dropped for the user for passing and scoring. For example when a student is studying in the university.
Then it prompts a user to buy a `pro-student` subscription where it allows the full access to the tests and learning them with no limits.

Better to manage the tarifs/plans for subscriptions, i.e. the price, details - in the admin-panle as well.

### Backend API

Use only native nodejs fetch.
The API should be a RESTful http.
As the main backend framework - use Fastify.

#### Basics:

Auth api:
- Authentication is done through the telegram, when the bot starts - it recieves the telegramId and a name of a user.

Tests api:
- CRUD operations for admins to manage the tests
- Only READ enpoints to the client

Statistics api:
- Track progress and statistics of a user

### Database

As the database of tests use the `db` folder where there're `.json` files for differect types of subjects.

### Prod and Deployment

Use Docker compose.