# TODO list

- Look at the URL structure for serving images. It's currently `/i` and doesn't
  include the collection name in it. I think we need to rethink this. Consider
  whether everything should be by the filename, including the other API routes,
  and not id. But what does that mean for two files with the same filename?
- The renderers should be able to validate the params. If not, send back HTTP
  error
- Document the API routes on how to load a file on the detail page
