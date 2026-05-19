// Simulated BAD controller — directly injects ApplicationDbContext (violates LayeredBackend)
using api.Data;
using Microsoft.AspNetCore.Mvc;

namespace api.Controllers
{
    [ApiController]
    [Route("api/bad")]
    public class BadController : ControllerBase
    {
        private readonly ApplicationDbContext _dbContext;

        public BadController(ApplicationDbContext dbContext)
        {
            _dbContext = dbContext;
        }

        [HttpGet]
        public IActionResult GetAll()
        {
            // VIOLATION: Controller accessing DB directly, bypassing Services layer
            var vps = _dbContext.Vpses.ToList();
            return Ok(vps);
        }
    }
}
